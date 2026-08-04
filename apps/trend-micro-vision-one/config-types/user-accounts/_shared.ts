// Shared helpers for the Trend Vision One IAM User Accounts config type — tenant
// console user accounts (invite / role / status / description) — deploy +
// rollback + drift.
//
// Endpoint paths + body shapes are CONFIRMED against the official Trend
// `vision-one-mcp-server` Go client (trendmicro/vision-one-mcp-server,
// internal/v1client/iam.go): invite is `POST /v3.0/iam/accounts` (email, role,
// authType, description), list is `GET /v3.0/iam/accounts`, update is
// `PATCH /v3.0/iam/accounts/{id}` (role, status, description — no email/authType)
// and delete is `DELETE /v3.0/iam/accounts/{id}`. VERIFY the list-response
// envelope and the exact set of role names (Vision One custom RBAC roles are
// tenant-defined, not a fixed enum) against a live Vision One tenant.

export const ACCOUNT_ENDPOINTS = {
  /** List accounts. GET; returns { items: [...], nextLink } (assumed — VERIFY). */
  list: '/iam/accounts',
  /** Invite (create) an account. POST; body is { email, role, authType, description? }. CONFIRMED. */
  invite: '/iam/accounts',
} as const

/** Per-account path used for update (PATCH) and delete (DELETE). CONFIRMED. */
export function accountItemPath(id: string): string {
  return `/iam/accounts/${encodeURIComponent(id)}`
}

/** Accepted auth types for a new invite. CONFIRMED (vision-one-mcp-server tool enum). */
export const AUTH_TYPES = new Set(['local', 'saml', 'samlGroup'])
/** Accepted account statuses (update only). CONFIRMED (vision-one-mcp-server tool enum). */
export const ACCOUNT_STATUSES = new Set(['enabled', 'disabled'])

/**
 * A Trend Vision One IAM account as read back from the list endpoint. Field names
 * are per the confirmed Go client request/response shapes — VERIFY the exact list
 * envelope against a live Vision One tenant.
 */
export interface UserAccount {
  id?: string
  email?: string
  role?: string
  authType?: string
  status?: string
  description?: string
  [key: string]: unknown
}

/** Trim + lowercase a value so two that differ only in case still match. */
export function normalizeValue(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

/**
 * Vision One list responses carry accounts on `items` (with a `nextLink` for
 * pagination), matching every other v3.0 list in this app. Accept either that
 * shape or a bare array. VERIFY against live Vision One.
 */
export function accountsFromResponse(json: unknown): UserAccount[] {
  if (Array.isArray(json)) return json as UserAccount[]
  if (json && typeof json === 'object') {
    const items = (json as Record<string, unknown>).items
    if (Array.isArray(items)) return items as UserAccount[]
  }
  return []
}

/** Find a live account by its (normalized) email — the config-as-code identity. */
export function findAccountByEmail(accounts: UserAccount[], email: string): UserAccount | null {
  const target = normalizeValue(email)
  if (!target) return null
  return accounts.find((a) => normalizeValue(a.email) === target) ?? null
}

/** The parsed canvas fields for one user account. */
export interface AccountFields {
  email: string
  role: string
  authType: string
  status: string
  description: string
}

/**
 * Parse a canvas item's fields into an account definition. Returns null when the
 * required email, role or a valid auth type is missing (deploy skips such items).
 * `status` defaults to "enabled" when left blank.
 */
export function parseAccountFields(fields: Record<string, unknown>): AccountFields | null {
  const email = String(fields.email ?? '').trim()
  const role = String(fields.role ?? '').trim()
  const authType = String(fields.authType ?? '').trim()
  const status = String(fields.status ?? '').trim() || 'enabled'
  const description = String(fields.description ?? '').trim()
  if (!email || !role || !AUTH_TYPES.has(authType)) return null
  return { email, role, authType, status, description }
}

/** Invite (create) request body — only the fields the invite endpoint accepts. */
export function buildInviteBody(fields: AccountFields): Record<string, unknown> {
  const body: Record<string, unknown> = { email: fields.email, role: fields.role, authType: fields.authType }
  if (fields.description) body.description = fields.description
  return body
}

/** Update request body — only the fields the update endpoint accepts (no email/authType). */
export function buildUpdateBody(fields: AccountFields): Record<string, unknown> {
  return { role: fields.role, status: fields.status, description: fields.description }
}

/** Read the created account id from an invite response body, when the API returns one. */
export function accountIdFromResponse(json: unknown): string | null {
  if (json && typeof json === 'object') {
    const id = (json as Record<string, unknown>).id
    if (typeof id === 'string' && id.trim()) return id.trim()
  }
  return null
}
