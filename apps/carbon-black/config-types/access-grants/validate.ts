import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Carbon Black access-grant constraints -----------------------------------
//
// SCOPE: this manages the ROLES-only shape of a grant (Access Profiles and
// Grants API — `POST/GET/PUT/DELETE /access/v2/orgs/{org_key}/grants[/{principal_urn}]`)
// for a principal that is a USER already present in this org (resolved by
// email via the Users API — this app never creates, edits or deletes a user).
// A grant's `profiles` shape (multi-org / MSSP scoped access with conditions)
// is mutually exclusive with `roles` on the CBC side and out of scope here — a
// principal already carrying a profiles-based grant is left untouched and
// surfaced as a validation-time-unreachable, deploy-time error instead of being
// silently overwritten.
//
// Role identity is accepted as the FULL role URN (e.g. `psc:role::SECOPS_ROLE_MANAGER`
// for a built-in role, or `psc:role:{org_key}:CUSTOM_ROLE` for a custom one) —
// this app does not guess which form a given role name takes; find the exact
// URN via `GET /access/v3/orgs/{org_key}/principals/{token}/roles/permitted` or
// the CBC console's Grant Access screen.

export interface GrantSpec {
  itemId?: string
  /** principalEmail — the existing CBC user's email; resolved to a login_id at deploy time. */
  principalEmail: string
  /** role URNs to grant (additive — see deploy.ts). */
  roles: string[]
}

/** A grant as returned by GET .../grants/{principal_urn}. */
export interface LiveGrant {
  principal?: string
  principal_name?: string
  org_ref?: string
  roles?: string[] | null
  profiles?: unknown
  version?: number
}

/** A user as returned by GET .../users. */
export interface LiveUser {
  login_id?: number | string
  email?: string
  login_name?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** A role URN: `psc:role:<org_key-or-empty>:<name>`. The org segment may be empty (built-in roles). */
export const ROLE_URN_RE = /^psc:role:[A-Za-z0-9]*:[A-Za-z0-9_-]+$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function splitRoles(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map((x) => String(x).trim()) : asString(v).split(/[\n,]/).map((t) => t.trim())
  return [...new Set(raw.filter((t) => t.length > 0))]
}

export function extractGrantSpecs(canvas: CanvasSnapshot): GrantSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      principalEmail: (asString(f.principalEmail) || asString(item.name)).toLowerCase(),
      roles: splitRoles(f.roles),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractGrantSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.principalEmail) {
      errors.push({ field: `${prefix}.principalEmail`, message: 'Principal email is required', code: 'required' })
    } else {
      if (!EMAIL_RE.test(spec.principalEmail)) {
        errors.push({ field: `${prefix}.principalEmail`, message: `"${spec.principalEmail}" is not a valid email address`, code: 'invalid_email' })
      }
      if (seen.has(spec.principalEmail)) {
        errors.push({ field: `${prefix}.principalEmail`, message: `Duplicate grant for "${spec.principalEmail}"`, code: 'duplicate_principal' })
      }
      seen.add(spec.principalEmail)
    }

    if (spec.roles.length === 0) {
      errors.push({ field: `${prefix}.roles`, message: 'At least one role URN is required', code: 'required' })
    } else {
      spec.roles.forEach((r, ri) => {
        if (!ROLE_URN_RE.test(r)) {
          errors.push({
            field: `${prefix}.roles[${ri}]`,
            message: `"${r}" is not a valid role URN — expected the form psc:role::NAME (built-in) or psc:role:{org_key}:NAME (custom)`,
            code: 'invalid_role_urn',
          })
        }
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
