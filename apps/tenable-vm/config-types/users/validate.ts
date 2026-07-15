import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Tenable Users API constraints -------------------------------------------

/**
 * Numeric role levels Tenable accepts for a user's `permissions`:
 * 16 = Basic, 32 = Scan Operator, 40 = Standard, 64 = Administrator.
 */
export const VALID_PERMISSIONS: readonly number[] = [16, 32, 40, 64]

/** Least-privilege default when the canvas leaves the role unset. */
export const DEFAULT_PERMISSIONS = 16

/** A username IS an email address — enforce a simple, permissive email shape. */
export const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface UserSpec {
  sectionName: string
  /** Login username — an email address; the logical identity (matched to user_id). */
  username: string
  /** Display name shown in the Tenable console. */
  name: string
  /** Numeric role level (16 / 32 / 40 / 64). */
  permissions: number
  /**
   * Write-only password. Tenable never returns it on GET, so it is REQUIRED on
   * a create (enforced in deploy, not here) and omitted on an update unless it
   * is being changed. undefined = blank = "keep the existing password".
   */
  password?: string
  /** Whether the account can authenticate. */
  enabled: boolean
}

/** Shape of a user returned by GET /users. Note: `password` is never present. */
export interface LiveUser {
  id?: number
  uuid?: string
  username?: string
  name?: string
  permissions?: number
  enabled?: boolean
  email?: string
}

/** Coerce a checkbox value to a boolean, falling back to a default when unset. */
function toBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.toLowerCase() !== 'false' && value !== '0'
  return Boolean(value)
}

/**
 * Coerce a permissions field (select value, arrives as a string or number) to a
 * number. Empty falls back to the least-privilege default; a non-numeric value
 * becomes NaN so validate can reject it.
 */
export function toPermissions(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_PERMISSIONS
  if (typeof value === 'number') return value
  const n = Number(String(value).trim())
  return Number.isFinite(n) ? n : NaN
}

/** Each canvas section describes one Tenable user account. */
export function extractUserSpecs(canvas: CanvasSnapshot): UserSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    // Preserve the exact password characters (a password may contain spaces),
    // but treat a whitespace-only value as blank = "keep existing".
    const rawPassword = typeof fields.password === 'string' ? fields.password : ''
    const password = rawPassword.trim() ? rawPassword : undefined

    return {
      sectionName: section.name,
      username: typeof fields.username === 'string' ? fields.username.trim() : '',
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      permissions: toPermissions(fields.permissions),
      password,
      enabled: toBool(fields.enabled, true),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate user configurations against Tenable Users API constraints:
 * a username (email) and a name are required, the role must be one of the
 * accepted numeric levels, and the username — a user's logical identity — must
 * be unique across the canvas.
 *
 * The password is intentionally NOT required here. validate is static and
 * cannot tell a create from an update; a blank password means "keep the
 * existing password" on an update. deploy enforces that a password IS present
 * when the account does not yet exist (a create).
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
  const seenUsernames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // username — required, must look like an email (it IS the login email)
    if (!spec.username) {
      errors.push({ field: `${prefix}.username`, message: 'Username (email) is required', code: 'required' })
    } else if (!EMAIL_PATTERN.test(spec.username)) {
      errors.push({
        field: `${prefix}.username`,
        message: 'Username must be a valid email address, e.g. alice@example.com',
        code: 'invalid_email',
      })
    }

    // name — required display name
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Full name is required', code: 'required' })
    }

    // permissions — must be one of the accepted numeric role levels
    if (!VALID_PERMISSIONS.includes(spec.permissions)) {
      errors.push({
        field: `${prefix}.permissions`,
        message:
          'Role must be one of 16 (Basic), 32 (Scan Operator), 40 (Standard) or 64 (Administrator)',
        code: 'invalid_permissions',
      })
    }

    // username is the logical identity (matched to user_id) — dedupe on it.
    // Email logins are case-insensitive, so two usernames differing only in
    // case are the SAME account and must not both be declared.
    if (spec.username) {
      const key = spec.username.toLowerCase()
      if (seenUsernames.has(key)) {
        errors.push({
          field: `${prefix}.username`,
          message: `Duplicate user "${spec.username}" — each username may only be declared once per canvas`,
          code: 'duplicate_user',
        })
      }
      seenUsernames.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
