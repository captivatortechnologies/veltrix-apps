import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta Custom Admin Roles API constraints ---------------------------------
//
// A custom admin role is a named, least-privilege bundle of permission types.
// Its logical identity is its LABEL. Endpoints:
//   GET  /iam/roles                         — list ({ roles: [...] })
//   POST /iam/roles                         — create ({ label, description, permissions[] })
//   PUT  /iam/roles/{roleIdOrLabel}         — replace label/description ONLY
//   DEL  /iam/roles/{roleIdOrLabel}         — delete
//   GET/POST/DELETE /iam/roles/{id}/permissions[/{permissionType}] — manage perms
// Only CUSTOM roles live here; Okta's STANDARD/built-in roles are protected.

/**
 * Okta's standard/built-in admin role types. They are predefined and cannot be
 * created, updated or deleted through the custom-roles API (they are assigned to
 * principals via the role-assignment API). validate rejects a custom role LABEL
 * that collides with one of these so the author gets a clear error up front.
 */
export const STANDARD_ROLE_TYPES = [
  'SUPER_ADMIN',
  'ORG_ADMIN',
  'API_ACCESS_MANAGEMENT_ADMIN',
  'APP_ADMIN',
  'GROUP_ADMIN',
  'GROUP_MEMBERSHIP_ADMIN',
  'HELP_DESK_ADMIN',
  'MOBILE_ADMIN',
  'READ_ONLY_ADMIN',
  'REPORT_ADMIN',
  'USER_ADMIN',
] as const

/** True when `label` collides with an Okta standard/built-in admin role type. */
export function isStandardRoleType(label: string): boolean {
  const upper = label.trim().toUpperCase().replace(/\s+/g, '_')
  return (STANDARD_ROLE_TYPES as readonly string[]).includes(upper)
}

/** Role label / description length caps. */
export const MAX_ROLE_LABEL_LENGTH = 255

/**
 * Plausible Okta permission-type shape, e.g. `okta.users.read`,
 * `okta.groups.manage`. Used only for a soft WARNING — Okta owns the
 * authoritative, evolving catalog and rejects an unknown permission at deploy.
 */
export const PERMISSION_PATTERN = /^okta\.[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface RoleSpec {
  sectionName: string
  /** Role label — the logical identity deploy matches on. */
  label: string
  /** Role description (required by Okta). */
  description: string
  /** De-duplicated permission-type strings (e.g. okta.users.read). */
  permissions: string[]
}

/** Shape of a role returned by GET /iam/roles (list) and GET /iam/roles/{id}. */
export interface LiveRole {
  id?: string
  label?: string
  description?: string
  created?: string
  lastUpdated?: string
  _links?: unknown
  [key: string]: unknown
}

/** Shape of a permission returned by GET /iam/roles/{id}/permissions. */
export interface LiveRolePermission {
  /** The permission-type string, e.g. okta.users.read. */
  label?: string
  [key: string]: unknown
}

/** Split a canvas `tags` value (array) or comma/newline string into trimmed items. */
export function splitList(value: unknown): string[] {
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

/** Each canvas item describes one Okta custom admin role. */
export function extractRoleSpecs(canvas: CanvasSnapshot): RoleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      label: typeof fields.label === 'string' ? fields.label.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      // De-dupe the permission set so reconciliation math is stable.
      permissions: [...new Set(splitList(fields.permissions))],
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate custom-admin-role configurations against the Okta Roles API. Static
 * only — it never contacts Okta:
 *   - label is required, <= 255 chars, unique within the canvas, and not one of
 *     Okta's standard/built-in admin role types
 *   - description is required
 *   - at least one permission is required; each is flagged (WARNING) if it does
 *     not look like an okta.* permission type — Okta owns the authoritative list
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractRoleSpecs(ctx.canvas)
  const seenLabels = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // label — required, <= 255 chars, unique, and not a standard role type
    if (!spec.label) {
      errors.push({ field: `${prefix}.label`, message: 'Role label is required', code: 'required' })
    } else {
      if (spec.label.length > MAX_ROLE_LABEL_LENGTH) {
        errors.push({
          field: `${prefix}.label`,
          message: `Role label must be ${MAX_ROLE_LABEL_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      if (isStandardRoleType(spec.label)) {
        errors.push({
          field: `${prefix}.label`,
          message: `"${spec.label}" is an Okta standard/built-in admin role — it is managed by Okta and cannot be created here. Choose a different label for your custom role.`,
          code: 'standard_role',
        })
      }
      const key = spec.label.toLowerCase()
      if (seenLabels.has(key)) {
        errors.push({
          field: `${prefix}.label`,
          message: `Duplicate role "${spec.label}" — each role label may only be declared once per canvas`,
          code: 'duplicate_label',
        })
      }
      seenLabels.add(key)
    }

    // description — required by Okta
    if (!spec.description) {
      errors.push({ field: `${prefix}.description`, message: 'Role description is required', code: 'required' })
    }

    // permissions — at least one; each flagged (warning) if shape looks off
    if (spec.permissions.length === 0) {
      errors.push({
        field: `${prefix}.permissions`,
        message: 'Grant at least one permission, e.g. okta.users.read',
        code: 'required',
      })
    } else {
      for (const perm of spec.permissions) {
        if (!PERMISSION_PATTERN.test(perm)) {
          warnings.push({
            field: `${prefix}.permissions`,
            message: `"${perm}" does not look like an Okta permission type (expected e.g. okta.users.read) — Okta will reject an unknown permission at deploy time`,
            code: 'suspicious_permission',
          })
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
