// ========================================================================
// Credentials — how an app authenticates to a server ("connection").
//
// A "connection" pairs a server (a platform *component* — see inventory.ts)
// with a *credential*: the account and write-only secret used to reach that
// server. These helpers are a typed surface over the platform's credentials
// API (POST /api/credentials, GET /api/tools/:toolId/credentials, PUT/DELETE
// /api/credentials/:id).
//
// Framework-free (no React). Every call goes through the same `authFetch` the
// '/client' subpath exports, so requests carry the platform's Authorization
// header. Non-2xx responses are surfaced as thrown Errors carrying the
// platform's error text.
//
// SECURITY: `listCredentials` returns a REDACTED {@link CredentialSummary} —
// secret material (password / apiToken / certificate) is dropped before it
// reaches app code, so secrets are never held in memory or logged. Only whether
// a secret exists is surfaced (`hasSecret`). Secrets are write-only: they can be
// set via create/update, never read back.
// ========================================================================

import type { CredentialInput, CredentialSummary } from '../types/platform'
import { authFetch } from './index'

/** Base route for the platform's credentials API. */
const CREDENTIALS_API = '/api/credentials'

/**
 * Loosely-typed shape of a raw credential as returned by the platform, before
 * it is redacted down to the {@link CredentialSummary} surface. The secret
 * fields (`password` / `apiToken` / `certificate`) are read here only to derive
 * `hasSecret` — they are never carried into app-visible data.
 */
interface RawCredential {
  id: string
  name?: string
  username?: string
  type?: string | null
  toolId?: string
  password?: string | null
  apiToken?: string | null
  certificate?: string | null
}

/** Build an Error from a non-2xx response, preferring the platform's message. */
async function credentialError(res: Response): Promise<Error> {
  const text = await res.text().catch(() => '')
  if (text) {
    try {
      const body = JSON.parse(text) as { error?: string; message?: string }
      const message = body?.error ?? body?.message
      if (message) return new Error(message)
    } catch {
      // Body was not JSON — fall through and use the raw text.
    }
    return new Error(text)
  }
  return new Error(`HTTP ${res.status}`)
}

/**
 * Redact a raw platform credential down to the app-visible summary, dropping
 * every secret field and surfacing only whether a secret is stored.
 */
function toCredentialSummary(raw: RawCredential): CredentialSummary {
  const hasSecret = Boolean((raw.apiToken && raw.apiToken.length > 0) || (raw.password && raw.password.length > 0))
  return {
    id: String(raw.id),
    name: raw.name ?? '',
    username: raw.username ?? '',
    type: raw.type ?? null,
    toolId: raw.toolId ?? '',
    hasSecret,
  }
}

/**
 * List the redacted credentials registered for a tool. GET
 * /api/tools/:toolId/credentials. Secrets are stripped before return — see the
 * module's SECURITY note. Returns an empty array when the tool has none.
 */
export async function listCredentials(toolId: string): Promise<CredentialSummary[]> {
  const res = await authFetch(`/api/tools/${encodeURIComponent(toolId)}/credentials`)
  if (!res.ok) throw await credentialError(res)
  const data = (await res.json()) as unknown
  const rows: RawCredential[] = Array.isArray(data)
    ? (data as RawCredential[])
    : Array.isArray((data as { data?: unknown })?.data)
      ? ((data as { data: RawCredential[] }).data)
      : []
  return rows.map(toCredentialSummary)
}

/**
 * Create a credential. POST /api/credentials. The platform requires `name`,
 * `username`, `password`, `toolId`, and `tagIds` — this helper defaults
 * `tagIds` to `[]` and `password` to `''` (valid for token-only auth, where the
 * secret travels in `apiToken`). Returns the new credential's id.
 */
export async function createCredential(input: CredentialInput): Promise<{ id: string }> {
  const res = await authFetch(CREDENTIALS_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: input.name,
      username: input.username,
      password: input.password ?? '',
      apiToken: input.apiToken,
      type: input.type,
      toolId: input.toolId,
      tagIds: input.tagIds ?? [],
    }),
  })
  if (!res.ok) throw await credentialError(res)
  const body = (await res.json()) as { id?: string }
  return { id: String(body.id) }
}

/**
 * Update a credential. PUT /api/credentials/:id. Only the fields you pass are
 * changed; omit `password`/`apiToken` to leave the stored secret untouched.
 */
export async function updateCredential(
  id: string,
  input: Partial<CredentialInput>,
): Promise<{ id: string }> {
  const body: Record<string, unknown> = {}
  if (input.name !== undefined) body.name = input.name
  if (input.username !== undefined) body.username = input.username
  if (input.password !== undefined) body.password = input.password
  if (input.apiToken !== undefined) body.apiToken = input.apiToken
  if (input.type !== undefined) body.type = input.type
  if (input.tagIds !== undefined) body.tagIds = input.tagIds
  const res = await authFetch(`${CREDENTIALS_API}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await credentialError(res)
  const result = (await res.json().catch(() => ({}))) as { id?: string }
  return { id: result.id ? String(result.id) : id }
}

/** Remove a credential. DELETE /api/credentials/:id. */
export async function removeCredential(id: string): Promise<void> {
  const res = await authFetch(`${CREDENTIALS_API}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  // 204 No Content is the platform's success response for delete.
  if (!res.ok && res.status !== 204) throw await credentialError(res)
}
