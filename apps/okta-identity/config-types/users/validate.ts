import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// Okta Users — SAFE-BY-DESIGN config type.
//
// Manages ONLY the users declared in the canvas (a controlled set: break-glass
// admins, service/bot accounts, sandbox seed users). It NEVER touches a user
// that is not in the canvas, and it NEVER deletes a user — deactivate
// (DEPROVISIONED) is the strongest action, and only when an item explicitly
// asks for it. Field keys must match what deploy / drift / health read.
// =============================================================================

/** Desired lifecycle state for a declared user (the only manageable targets). */
export const USER_STATUSES = ['STAGED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const
export type UserStatus = (typeof USER_STATUSES)[number]

/** Okta live statuses treated as "effectively active" for reconciliation. */
export const ACTIVE_LIKE_STATUSES = ['ACTIVE', 'PROVISIONED', 'RECOVERY', 'PASSWORD_EXPIRED', 'LOCKED_OUT']

// --- Spec extraction shared by deploy / rollback / healthCheck / drift ---------

export interface UserSpec {
  sectionName: string
  /** Stable canvas item id — survives a login change; used for rename-safe match. */
  itemId?: string
  /** Okta login (username, usually the email) — the user's logical identity. */
  login: string
  email: string
  firstName: string
  lastName: string
  /** Desired lifecycle state. */
  status: UserStatus
  /** When activating, whether Okta emails the user an activation link. */
  sendActivationEmail: boolean
  /** Optional profile attributes (only sent when non-empty). */
  displayName?: string
  title?: string
  department?: string
  mobilePhone?: string
  secondEmail?: string
}

/** Shape of a user returned by GET /users and GET /users/{idOrLogin}. */
export interface LiveUser {
  id?: string
  status?: string
  profile?: {
    login?: string
    email?: string
    firstName?: string
    lastName?: string
    displayName?: string
    title?: string
    department?: string
    mobilePhone?: string
    secondEmail?: string
    [key: string]: unknown
  }
  created?: string
  activated?: string
  statusChanged?: string
  lastUpdated?: string
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const optStr = (v: unknown): string | undefined => {
  const s = str(v)
  return s.length > 0 ? s : undefined
}

/** Coerce a canvas checkbox value to a boolean. */
export function coerceBoolean(value: unknown, defaultValue: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 1) return true
  if (value === 'false' || value === 0) return false
  return defaultValue
}

/** Normalize a desired-status field to a known UserStatus (defaults to STAGED). */
export function normalizeStatus(value: unknown): UserStatus {
  const s = str(value).toUpperCase()
  return (USER_STATUSES as readonly string[]).includes(s) ? (s as UserStatus) : 'STAGED'
}

/** Each canvas section describes one Okta user. */
export function extractUserSpecs(canvas: CanvasSnapshot): UserSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const f = section.fields ?? {}
    return {
      sectionName: section.name,
      itemId: section.id,
      login: str(f.login),
      email: str(f.email),
      firstName: str(f.firstName),
      lastName: str(f.lastName),
      status: normalizeStatus(f.status),
      sendActivationEmail: coerceBoolean(f.sendActivationEmail, false),
      displayName: optStr(f.displayName),
      title: optStr(f.title),
      department: optStr(f.department),
      mobilePhone: optStr(f.mobilePhone),
      secondEmail: optStr(f.secondEmail),
    }
  })
}

// A pragmatic email check — Okta is the authority, this only catches typos early.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// --- Validate handler ---------------------------------------------------------

/**
 * Validate user configurations against Okta Users API constraints. Static rules
 * only (no network): login/email/firstName/lastName required, email + login look
 * like emails, status is a known target, and the login — the user's identity —
 * is unique across the canvas. The live protections (never touch undeclared
 * users, never delete) are enforced in deploy.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractUserSpecs(ctx.canvas)
  const seenLogins = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.login) {
      errors.push({ field: `${prefix}.login`, message: 'Login is required — the user\'s username (usually their email)', code: 'required' })
    } else if (!EMAIL_RE.test(spec.login)) {
      warnings.push({ field: `${prefix}.login`, message: 'Login does not look like an email address — Okta usually expects the login to be an email', code: 'login_not_email' })
    }

    if (!spec.email) {
      errors.push({ field: `${prefix}.email`, message: 'Primary email is required', code: 'required' })
    } else if (!EMAIL_RE.test(spec.email)) {
      errors.push({ field: `${prefix}.email`, message: 'Email is not a valid email address', code: 'invalid_email' })
    }

    if (spec.secondEmail && !EMAIL_RE.test(spec.secondEmail)) {
      errors.push({ field: `${prefix}.secondEmail`, message: 'Secondary email is not a valid email address', code: 'invalid_email' })
    }

    if (!spec.firstName) {
      errors.push({ field: `${prefix}.firstName`, message: 'First name is required', code: 'required' })
    }
    if (!spec.lastName) {
      errors.push({ field: `${prefix}.lastName`, message: 'Last name is required', code: 'required' })
    }

    // status is normalized to a known value at extraction (the field is a fixed
    // select), so it's always valid here — no error branch needed.

    // Make the safety model explicit to the author.
    if (spec.status === 'DEACTIVATED') {
      warnings.push({
        field: `${prefix}.status`,
        message: 'Status is DEACTIVATED — deploy will deactivate (deprovision) this user. Users are never deleted, and users not listed in this canvas are never touched.',
        code: 'user_will_deactivate',
      })
    }

    // login is the logical identity — dedupe on it (case-insensitive, since Okta
    // treats logins case-insensitively).
    if (spec.login) {
      const key = spec.login.toLowerCase()
      if (seenLogins.has(key)) {
        errors.push({ field: `${prefix}.login`, message: `Duplicate login "${spec.login}" — each user may only be declared once per canvas`, code: 'duplicate_user' })
      }
      seenLogins.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
