// Shared helpers for the runZero Users config type (deploy + rollback + drift + validate).
//
// A runZero User is an account-level user account with a default role plus optional per-organization
// role overrides. The console API models it as (verified against runZeroInc/runzero-api
// runzero-api.yml — User / UserOptions / UserInviteOptions):
//   List:    GET    /account/users              → array of User
//   Create:  PUT    /account/users               body UserOptions        → User (no email sent)
//   Invite:  PUT    /account/users/invite         body UserInviteOptions  → User (sends an email invite)
//   Get:     GET    /account/users/{id}
//   Update:  PATCH  /account/users/{id}          body UserOptions        → User
//   Delete:  DELETE /account/users/{id}
//
// FLAG (scope): users are ACCOUNT-scoped resources — they live under /account, NOT /org. This config
// type requires the connection to carry an ACCOUNT-scoped runZero API key (the same flag as
// scan-templates); an Organization key gets 401/403 here.
//
// FLAG (destructive rollback): a rollback that undoes a CREATE deletes the user account. This
// mirrors the rollback shape already used elsewhere in this app (delete what was created).
//
// NO SECRET MATERIAL: this config type never sets or reads a password. Account creation either
// leaves the account passwordless until the user sets one via SSO, or (sendInvite) emails the new
// user a signup link; password reset remains an out-of-band action (/account/users/{id}/resetPassword)
// this app deliberately does not expose as declarative config.
//
// ROLE VOCABULARY: runZero's own docs (help.runzero.com/docs/managing-your-team/) describe the role
// set in UI terms — Administrator / User / Billing / Annotator / Viewer / No access — while the
// OpenAPI spec's own examples for org_default_role/org_roles use the lowercase wire values "admin"
// and "viewer". The exact full wire-value vocabulary is NOT independently re-verified against a live
// account beyond these two examples, so this config type treats role values as free text with a
// soft validate warning rather than a hard-coded enum (see KNOWN_ROLE_HINTS below).

/** Role values seen in the spec's own examples — used only for a soft, non-blocking validate hint. */
export const KNOWN_ROLE_HINTS = ['admin', 'user', 'viewer', 'annotator', 'billing'] as const

/** One runZero User as returned by GET /account/users (subset of the fields we use). */
export interface RunzeroUser {
  id?: string
  name?: string
  first_name?: string
  last_name?: string
  email?: string
  client_admin?: boolean
  org_default_role?: string
  org_roles?: Record<string, string>
  sso_only?: boolean
  mfa_enabled?: boolean
  [key: string]: unknown
}

/** The UserOptions request body for PUT (direct create) / PATCH (update). */
export interface RunzeroUserOptions {
  first_name: string
  last_name: string
  email: string
  client_admin: boolean
  org_default_role: string
  org_roles: Record<string, string>
}

/** The UserInviteOptions request body for PUT /account/users/invite (create + email invite). */
export interface RunzeroUserInviteOptions extends RunzeroUserOptions {
  subject?: string
  message?: string
}

/** One entry in deploy's rollbackData.previous — what deploy did to a single user. */
export interface UserRollbackEntry {
  email: string
  userId: string | null
  existed: boolean
  prior: RunzeroUser | null
}

/** Trim any value to a string. */
export function text(value: unknown): string {
  return String(value ?? '').trim()
}

/** Coerce a scalar canvas value to a string (booleans/numbers included), for the org_roles map. */
function coerceScalar(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  return String(value).trim()
}

/**
 * Read a canvas `keyvalue` field (organization id → role name) into a flat string map. The control
 * emits an array of { key, value } rows; an object map and a `key=value` line string are also
 * tolerated (mirrors the scan-templates params helper).
 */
export function readOrgRoles(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>
        const key = text(rec.key ?? rec.name)
        if (key) out[key] = coerceScalar(rec.value)
      }
    }
    return out
  }
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const k = key.trim()
      if (k) out[k] = coerceScalar(v)
    }
    return out
  }
  if (typeof value === 'string' && value.trim()) {
    for (const line of value.split(/[\r\n,]+/)) {
      const eq = line.indexOf('=')
      if (eq > 0) {
        const k = line.slice(0, eq).trim()
        if (k) out[k] = line.slice(eq + 1).trim()
      }
    }
  }
  return out
}

/** True when two org-roles maps describe the same set of key→value pairs. */
export function orgRolesEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  return ak.every((k) => a[k] === b[k])
}

/** Find a live user by email (case-insensitive — the stable identity for upsert/drift). */
export function findUser(users: RunzeroUser[], email: string): RunzeroUser | null {
  const e = email.trim().toLowerCase()
  if (!e) return null
  return users.find((u) => text(u.email).toLowerCase() === e) ?? null
}

/** Build the shared User fields from canvas fields (used by both create paths and update). */
function buildBaseUserOptions(fields: Record<string, unknown>): RunzeroUserOptions {
  return {
    first_name: text(fields.firstName),
    last_name: text(fields.lastName),
    email: text(fields.email),
    client_admin: fields.clientAdmin === true,
    org_default_role: text(fields.orgDefaultRole),
    org_roles: readOrgRoles(fields.orgRoles),
  }
}

/** Build the UserOptions body for a direct create (PUT /account/users) or update (PATCH). */
export function buildUserOptions(fields: Record<string, unknown>): RunzeroUserOptions {
  return buildBaseUserOptions(fields)
}

/** Build the UserInviteOptions body for PUT /account/users/invite. */
export function buildUserInviteOptions(fields: Record<string, unknown>): RunzeroUserInviteOptions {
  const base = buildBaseUserOptions(fields)
  const subject = text(fields.inviteSubject)
  const message = text(fields.inviteMessage)
  return { ...base, ...(subject ? { subject } : {}), ...(message ? { message } : {}) }
}

/** Build a UserOptions body that restores a prior recorded User (rollback). Email stays fixed. */
export function buildUserOptionsFromPrior(prior: RunzeroUser): RunzeroUserOptions {
  return {
    first_name: text(prior.first_name),
    last_name: text(prior.last_name),
    email: text(prior.email),
    client_admin: prior.client_admin === true,
    org_default_role: text(prior.org_default_role),
    org_roles: prior.org_roles ?? {},
  }
}

/** Whether a canvas item requests an email invite on create (defaults to true — sendInvite unset). */
export function wantsInvite(fields: Record<string, unknown>): boolean {
  return fields.sendInvite !== false
}
