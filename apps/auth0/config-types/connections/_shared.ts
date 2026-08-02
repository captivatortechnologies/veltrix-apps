// Shared helpers for the Auth0 Connections config type (deploy + rollback + drift).
//
// Connections are identity providers — GET/POST /api/v2/connections and
// GET/PATCH/DELETE /api/v2/connections/{id}. The Management API keys a connection
// on the server-assigned `id`, so this config type upserts by connection NAME
// (Auth0 enforces a unique name per tenant). `name` and `strategy` are set at
// creation and are NOT changed on update, so the PATCH body omits them.
//
// `options` is a strategy-dependent object; it is authored as free-form JSON.
// Secret-bearing option keys (client_secret, ...) are returned masked by Auth0,
// so they are excluded from drift comparison and from the rollback restore body
// to avoid overwriting a live secret with its mask.
//
// Verified against the official Auth0 Management API v2 (Connections):
//   https://auth0.com/docs/api/management/v2/connections/post-connections
//   https://auth0.com/docs/api/management/v2/connections/patch-connections-by-id

import { parseJsonObject, readOptionalString, readString, readStringArray } from '../../lib/fields'

/**
 * Curated set of common Auth0 connection strategies. Auth0 ships 50+ strategies;
 * these are the ones surfaced in the canvas select. Validation accepts any of
 * these; an operator needing another strategy edits the manifest/canvas.
 */
export const CONNECTION_STRATEGIES = new Set([
  'auth0',
  'google-oauth2',
  'facebook',
  'apple',
  'github',
  'windowslive',
  'linkedin',
  'twitter',
  'salesforce',
  'samlp',
  'waad',
  'adfs',
  'oidc',
  'okta',
  'ad',
  'email',
  'sms',
])

/** Option keys whose values Auth0 returns masked — never compared or restored. */
const SECRET_OPTION_KEY = /secret|password|private|_key$|cert/i

/** One connection as returned by the Management API. */
export interface Auth0Connection {
  id?: string
  name?: string
  strategy?: string
  display_name?: string
  enabled_clients?: string[]
  options?: Record<string, unknown>
  [key: string]: unknown
}

/** The create body — name + strategy are only sent when creating. */
export interface ConnectionCreateBody {
  name: string
  strategy: string
  display_name?: string
  enabled_clients?: string[]
  options?: Record<string, unknown>
}

/** The update body — name and strategy are immutable, so they are omitted. */
export interface ConnectionUpdateBody {
  display_name?: string
  enabled_clients?: string[]
  options?: Record<string, unknown>
}

/** Find a live connection by name (case-sensitive, trimmed) — the upsert identity. */
export function findConnectionByName(list: Auth0Connection[], name: string): Auth0Connection | null {
  const n = name.trim()
  if (!n) return null
  return list.find((c) => String(c.name ?? '').trim() === n) ?? null
}

/** Drop secret-bearing keys from an options object (Auth0 returns them masked). */
export function nonSecretOptions(options: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(options)) {
    if (!SECRET_OPTION_KEY.test(key)) out[key] = value
  }
  return out
}

function optionsFromFields(fields: Record<string, unknown>): Record<string, unknown> {
  const parsed = parseJsonObject(fields.options)
  return parsed.ok ? parsed.value : {}
}

/** Build the create body from canvas fields (name + strategy included). */
export function buildConnectionCreateBody(fields: Record<string, unknown>): ConnectionCreateBody {
  const body: ConnectionCreateBody = {
    name: readString(fields.name),
    strategy: readString(fields.strategy),
  }
  const displayName = readOptionalString(fields.display_name)
  if (displayName !== undefined) body.display_name = displayName
  const enabledClients = readStringArray(fields.enabled_clients)
  if (enabledClients.length > 0) body.enabled_clients = enabledClients
  const options = optionsFromFields(fields)
  if (Object.keys(options).length > 0) body.options = options
  return body
}

/** Build the update body from canvas fields (name + strategy omitted — immutable). */
export function buildConnectionUpdateBody(fields: Record<string, unknown>): ConnectionUpdateBody {
  const body: ConnectionUpdateBody = {}
  const displayName = readOptionalString(fields.display_name)
  if (displayName !== undefined) body.display_name = displayName
  const enabledClients = readStringArray(fields.enabled_clients)
  if (enabledClients.length > 0) body.enabled_clients = enabledClients
  const options = optionsFromFields(fields)
  if (Object.keys(options).length > 0) body.options = options
  return body
}

/**
 * Capture the prior managed state of a live connection for rollback. Secret option
 * keys are stripped so a restore never rewrites a live secret with Auth0's mask.
 */
export function snapshotConnection(conn: Auth0Connection): ConnectionUpdateBody {
  const body: ConnectionUpdateBody = {
    display_name: typeof conn.display_name === 'string' ? conn.display_name : '',
    enabled_clients: Array.isArray(conn.enabled_clients) ? conn.enabled_clients : [],
    options: nonSecretOptions(conn.options ?? {}),
  }
  return body
}
