import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// Splunk Cloud users — validation + the spec extraction shared by
// deploy / rollback / healthCheck / driftDetect.
//
// Users, like roles, are IDENTITY — and ACS cannot manage identity (it covers
// indexes, HEC, IP allow lists, ports, limits, maintenance windows, apps and
// tokens, nothing else). They therefore go to the same REST endpoint Splunk
// Enterprise uses, /services/authentication/users, on the stack's management
// port 8089 — NOT ACS. See lib/splunkRest.ts.
//
// PASSWORD IS OUT OF SCOPE. Creating a user over REST requires a `password`,
// but storing/rotating user passwords as canvas config is a secret-handling
// anti-pattern. This config type therefore manages ROLE ASSIGNMENT + ATTRIBUTES
// for EXISTING users only; it never sends a password and never creates a user.
// (deploy.ts fails clearly if a declared user does not yet exist.)
// =============================================================================

/**
 * Splunk usernames are case-insensitive and may not contain spaces, colons or
 * forward slashes. Email-style usernames (user@example.com) are common, so the
 * pattern allows letters, digits, dot, underscore, hyphen and `@`, and must
 * begin with a letter or digit. Uppercase is accepted (Splunk folds case).
 */
export const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/
export const MAX_USERNAME_LENGTH = 100

/** Splunk role names are lowercase; no spaces, colons or slashes. */
export const ROLE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

/** App ids (defaultApp). */
export const APP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

/** Pragmatic single-address email check — enough to catch typos, not RFC 5322. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Highly privileged roles. sc_admin is the Splunk Cloud administrator role and
 * admin is Splunk's built-in superuser — assigning either grants stack-wide
 * control, so it is warned on (not blocked; sometimes it is intended).
 */
export const PRIVILEGED_ROLES = new Set(['admin', 'sc_admin'])

export interface UserSpec {
  sectionName: string
  name: string
  roles: string[]
  email?: string
  realName?: string
  defaultApp?: string
  tz?: string
}

/**
 * Shape of a user as returned by
 * GET /services/authentication/users/{name} → entry[0].content.
 * Splunk returns `roles` as an array and the rest as strings.
 */
export interface LiveUser {
  roles?: string[]
  email?: string
  realname?: string
  defaultApp?: string
  tz?: string
}

/** Canvas list fields arrive as arrays (tags) or comma/newline text. */
export function toList(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

/** Normalize a live REST list value (array, or comma-separated string). */
export function normalizeLiveList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter((v) => v.length > 0)
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  }
  return []
}

/** A trimmed non-empty string, or undefined — mirrors how roles reads optional text. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Each canvas item describes one Splunk Cloud user's role assignment + attributes. */
export function extractUserSpecs(canvas: CanvasSnapshot): UserSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.username === 'string' ? fields.username.trim() : '',
      roles: toList(fields.roles),
      email: optionalString(fields.email),
      // Canvas key is `realname` (mirrors REST); `fullName` accepted as an alias.
      realName: optionalString(fields.realname) ?? optionalString(fields.fullName),
      defaultApp: optionalString(fields.defaultApp),
      tz: optionalString(fields.tz),
    }
  })
}

// --- Validate handler --------------------------------------------------------

/**
 * Validate Splunk Cloud user configurations against Splunk's user model:
 * username rules, required non-empty role assignment, role-name format, email
 * format (when present), default-app format, and duplicate usernames. Assigning
 * a highly privileged role (admin / sc_admin) is warned on, not blocked.
 *
 * Never touches the network — the REST prerequisites (port 8089 open; caller IP
 * on the `search-api` allow list) are surfaced at deploy/health-check time.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no user definitions', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  // Splunk usernames are case-insensitive, so duplicate detection is too.
  const seenNames = new Set<string>()

  for (const spec of extractUserSpecs(ctx.canvas)) {
    const prefix = spec.sectionName

    // --- Username -------------------------------------------------------------
    if (!spec.name) {
      errors.push({ field: `${prefix}.username`, message: 'Username is required', code: 'required' })
    } else {
      if (!USERNAME_RE.test(spec.name)) {
        errors.push({
          field: `${prefix}.username`,
          message:
            'Username must begin with a letter or number and contain only letters, numbers, dots, underscores, hyphens and "@" (Splunk rejects spaces, colons and slashes)',
          code: 'invalid_format',
        })
      }
      if (spec.name.length > MAX_USERNAME_LENGTH) {
        errors.push({
          field: `${prefix}.username`,
          message: `Username must be ${MAX_USERNAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.username`,
          message: `Duplicate user "${spec.name}" — each username may only be declared once per canvas (Splunk usernames are case-insensitive)`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // --- Roles (required, non-empty) -----------------------------------------
    if (spec.roles.length === 0) {
      errors.push({
        field: `${prefix}.roles`,
        message: 'At least one role is required — a Splunk user with no role can do nothing',
        code: 'required',
      })
    } else {
      const seenRoles = new Set<string>()
      for (const role of spec.roles) {
        if (!ROLE_NAME_RE.test(role)) {
          errors.push({
            field: `${prefix}.roles`,
            message: `"${role}" is not a valid Splunk role name (lowercase letters, numbers, underscores and hyphens; must begin with a letter or number)`,
            code: 'invalid_format',
          })
        }
        if (PRIVILEGED_ROLES.has(role)) {
          warnings.push({
            field: `${prefix}.roles`,
            message: `Assigning "${role}" grants stack-wide administrative access — confirm this user needs it (least privilege)`,
            code: 'privileged_role',
          })
        }
        if (seenRoles.has(role)) {
          warnings.push({
            field: `${prefix}.roles`,
            message: `Duplicate role "${role}" in this user's role list`,
            code: 'duplicate_role',
          })
        }
        seenRoles.add(role)
      }
    }

    // --- Email ----------------------------------------------------------------
    if (spec.email !== undefined && !EMAIL_RE.test(spec.email)) {
      errors.push({
        field: `${prefix}.email`,
        message: `"${spec.email}" is not a valid email address`,
        code: 'invalid_format',
      })
    }

    // --- Default app ----------------------------------------------------------
    if (spec.defaultApp !== undefined && !APP_NAME_RE.test(spec.defaultApp)) {
      errors.push({
        field: `${prefix}.defaultApp`,
        message: 'Default app must be a valid Splunk app id (letters, digits, underscores, dots, hyphens)',
        code: 'invalid_format',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
