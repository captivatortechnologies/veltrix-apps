// Shared helpers for the MISP Users config type (deploy + rollback + drift).
//
// MISP user shapes follow the 2.4 REST API (/admin/users/index,
// /admin/users/add, /admin/users/edit/{id}, /admin/users/delete/{id}); verify
// against a live MISP 2.4 instance.
//
// SECRET MATERIAL IS NEVER MANAGED HERE: `password`, `authkey`, `confirm_password`
// and `external_auth_key` are intentionally excluded from every field this type
// reads or writes. A new user is provisioned with NO password set by this type;
// `notify` (create only) asks MISP to email the new user a password-reset link
// via its own flow, so a real secret is never generated, stored, or transmitted
// by this app.

/** Valid yes/no select values from the canvas. */
export const YES_NO = new Set(['yes', 'no'])

/** One MISP user as returned inside a `{ User: {...} }` envelope by /admin/users/index. */
export interface MispUser {
  id?: number | string
  email?: string
  org_id?: number | string
  role_id?: number | string
  disabled?: boolean | number | string
  change_pw?: boolean | number | string
  termsaccepted?: boolean | number | string
  autoalert?: boolean | number | string
  contactalert?: boolean | number | string
  notification_daily?: boolean | number | string
  notification_weekly?: boolean | number | string
  notification_monthly?: boolean | number | string
  external_auth_required?: boolean | number | string
  nids_sid?: number | string
  gpgkey?: string
  certif_public?: string
  [key: string]: unknown
}

/** Normalize a yes/no select (or a boolean / 1|0) to a boolean. */
export function normalizeYesNo(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'yes' || s === 'true' || s === '1'
}

/** Coerce a MISP list response into rows (a bare array or a `{ response: [...] }` wrapper). */
function asRows(list: unknown): unknown[] {
  if (Array.isArray(list)) return list
  if (list && typeof list === 'object' && Array.isArray((list as { response?: unknown }).response)) {
    return (list as { response: unknown[] }).response
  }
  return []
}

/** Unwrap MISP's `[{ User: {...} }]` list into a flat array of users. */
export function usersFromList(list: unknown): MispUser[] {
  return asRows(list).map((row) =>
    row && typeof row === 'object' && 'User' in (row as Record<string, unknown>)
      ? ((row as { User: MispUser }).User)
      : (row as MispUser),
  )
}

/** Find a live user by email (case-insensitive — the stable identity; MISP enforces email uniqueness). */
export function findUser(users: MispUser[], email: string): MispUser | null {
  const e = email.trim().toLowerCase()
  if (!e) return null
  return users.find((u) => String(u.email ?? '').trim().toLowerCase() === e) ?? null
}

/**
 * Build the MISP user body from canvas fields (wrapped in `{ User: {...} }` by
 * callers). Never includes password/authkey/confirm_password/external_auth_key —
 * see the module-level note.
 */
export function buildUserFields(fields: Record<string, unknown>): MispUser {
  const gpgkey = String(fields.gpgkey ?? '').trim()
  const certifPublic = String(fields.certif_public ?? '').trim()
  const nidsSid = Number(fields.nids_sid ?? 0)
  return {
    email: String(fields.email ?? '').trim(),
    org_id: Number(fields.org_id ?? 0),
    role_id: Number(fields.role_id ?? 0),
    disabled: normalizeYesNo(fields.disabled),
    change_pw: normalizeYesNo(fields.change_pw),
    termsaccepted: normalizeYesNo(fields.termsaccepted),
    autoalert: normalizeYesNo(fields.autoalert),
    contactalert: normalizeYesNo(fields.contactalert),
    notification_daily: normalizeYesNo(fields.notification_daily),
    notification_weekly: normalizeYesNo(fields.notification_weekly),
    notification_monthly: normalizeYesNo(fields.notification_monthly),
    external_auth_required: normalizeYesNo(fields.external_auth_required),
    ...(nidsSid ? { nids_sid: nidsSid } : {}),
    ...(gpgkey ? { gpgkey } : {}),
    ...(certifPublic ? { certif_public: certifPublic } : {}),
  }
}
