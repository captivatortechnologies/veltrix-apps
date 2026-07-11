// ========================================================================
// Environments — the deployment scopes that determine where a configuration is
// pushed. Environments are the customer's platform tags (dev/staging/prod, …);
// a Connection (credential) or Access Server (component) is tied to one by
// carrying the environment id in its `tagIds`.
//
// A thin reader over the platform's environments API (/api/environments), used
// to populate the Environment picker on the Connections and Access Servers
// pages. Framework-free — every call goes through the same `authFetch` the
// '/client' subpath exports.
// ========================================================================

import type { EnvironmentRef } from '../types/pipeline'
import { authFetch } from './index'

/** Base route for the platform's environments API. */
const ENVIRONMENTS_API = '/api/environments'

interface RawEnvironment {
  id: string
  name?: string
}

/** Build an Error from a non-2xx response, preferring the platform's message. */
async function environmentError(res: Response): Promise<Error> {
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
 * List the customer's environments (deployment scopes). GET /api/environments
 * (the endpoint may return a bare array or a paginated `{ data, ... }` shape —
 * both are handled). Use the returned id as a `tagIds` entry to tie a Connection
 * or Access Server to that environment.
 */
export async function listEnvironments(): Promise<EnvironmentRef[]> {
  const res = await authFetch(ENVIRONMENTS_API)
  if (!res.ok) throw await environmentError(res)
  const body = (await res.json()) as unknown
  const rows: RawEnvironment[] = Array.isArray(body)
    ? (body as RawEnvironment[])
    : Array.isArray((body as { data?: unknown })?.data)
      ? ((body as { data: RawEnvironment[] }).data)
      : []
  return rows.map((env) => ({ id: String(env.id), name: env.name ?? '' }))
}
