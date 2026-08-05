import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Prisma Cloud user constraints -------------------------------------------
// Users are matched by EMAIL — the API's own identity key (GET/PUT/DELETE all
// address a user by email; there is no surrogate id at all). The write model
// (POST/PUT /v2/user) accepts a full `roleIds` array + `defaultRoleId`, but the
// read model (GET /v2/user[/{email}]) only ever returns the single active
// `roleId` — Prisma's API has no endpoint that returns a user's full multi-role
// assignment. Drift detection and rollback are scoped to what is actually
// readable; see deploy.ts / driftDetect.ts for how the unreadable `roleIds`
// superset is carried forward instead of guessed from a live read.
//
// `enabled` is a read-only field on the profile object itself — it is toggled
// through the separate `PATCH /user/{email}/status/{enabled}` endpoint, never
// through the create/update body.

export const MAX_EMAIL_LENGTH = 255
export const MAX_NAME_LENGTH = 300

export interface UserSpec {
  itemId?: string
  /** email — the identity (Prisma has no surrogate id for a user). */
  email: string
  firstName: string
  lastName: string
  timeZone: string
  defaultRoleId: string
  /** the full set of role ids this user should hold. */
  roleIds: string[]
  accessKeysAllowed: boolean
  enabled: boolean
}

/** A user as returned by GET /v2/user (UserProfileModel) — note the SINGULAR roleId. */
export interface LiveUser {
  email?: string
  firstName?: string
  lastName?: string
  timeZone?: string
  roleId?: string
  roleType?: string
  accessKeysAllowed?: boolean
  enabled?: boolean
  displayName?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown, fallback: boolean): boolean {
  if (v === undefined) return fallback
  return v === true || v === 'true'
}

export function splitIds(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map((x) => String(x).trim()) : asString(v).split(/[\n,]/).map((t) => t.trim())
  return [...new Set(raw.filter((t) => t.length > 0))]
}

export function extractUserSpecs(canvas: CanvasSnapshot): UserSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      email: asString(f.email) || item.name,
      firstName: asString(f.firstName),
      lastName: asString(f.lastName),
      timeZone: asString(f.timeZone),
      defaultRoleId: asString(f.defaultRoleId),
      roleIds: splitIds(f.roleIds),
      accessKeysAllowed: asBool(f.accessKeysAllowed, false),
      enabled: asBool(f.enabled, true),
    }
  })
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractUserSpecs(ctx.canvas)
  const seenEmails = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.email) {
      errors.push({ field: `${prefix}.email`, message: 'Email is required', code: 'required' })
    } else {
      if (spec.email.length > MAX_EMAIL_LENGTH) {
        errors.push({ field: `${prefix}.email`, message: `Email must be ${MAX_EMAIL_LENGTH} characters or fewer`, code: 'too_long' })
      }
      if (!EMAIL_RE.test(spec.email)) {
        errors.push({ field: `${prefix}.email`, message: 'Email must be a valid email address', code: 'invalid_email' })
      }
      const key = spec.email.toLowerCase()
      if (seenEmails.has(key)) {
        errors.push({ field: `${prefix}.email`, message: `Duplicate user "${spec.email}"`, code: 'duplicate_email' })
      }
      seenEmails.add(key)
    }

    if (!spec.firstName) {
      errors.push({ field: `${prefix}.firstName`, message: 'First name is required', code: 'required' })
    } else if (spec.firstName.length > MAX_NAME_LENGTH) {
      errors.push({ field: `${prefix}.firstName`, message: `First name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
    }

    if (!spec.lastName) {
      errors.push({ field: `${prefix}.lastName`, message: 'Last name is required', code: 'required' })
    } else if (spec.lastName.length > MAX_NAME_LENGTH) {
      errors.push({ field: `${prefix}.lastName`, message: `Last name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
    }

    if (!spec.timeZone) {
      errors.push({ field: `${prefix}.timeZone`, message: 'Time zone is required (e.g. America/Los_Angeles)', code: 'required' })
    }

    if (!spec.defaultRoleId) {
      errors.push({ field: `${prefix}.defaultRoleId`, message: 'Default role id is required', code: 'required' })
    }

    if (spec.roleIds.length === 0) {
      errors.push({ field: `${prefix}.roleIds`, message: 'At least one role id is required', code: 'required' })
    } else if (spec.defaultRoleId && !spec.roleIds.includes(spec.defaultRoleId)) {
      errors.push({ field: `${prefix}.roleIds`, message: 'Default role id must also be listed in role ids', code: 'default_role_not_in_role_ids' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
