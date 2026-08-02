// Shared helpers for the Auth0 Resource Servers (APIs) config type
// (deploy + rollback + drift).
//
// Resource servers are APIs — GET/POST /api/v2/resource-servers and
// GET/PATCH/DELETE /api/v2/resource-servers/{id}. The Management API keys a
// resource server on the server-assigned `id`; `identifier` (the audience URI) is
// unique and IMMUTABLE once set. This config type upserts by NAME (the human
// identity), so `identifier` is sent only on create and omitted from the PATCH body.
//
// `scopes` are authored as a key/value map (permission value → description) and
// projected to Auth0's [{ value, description }] array shape.
//
// Verified against the official Auth0 Management API v2 (Resource Servers):
//   https://auth0.com/docs/api/management/v2/resource-servers/post-resource-servers
//   https://auth0.com/docs/api/management/v2/resource-servers/patch-resource-servers-by-id

import { readKeyValueMap, readOptionalInt, readString } from '../../lib/fields'

/** Token signing algorithms Auth0 accepts. "" means "leave to Auth0's default" (HS256). */
export const SIGNING_ALGS = new Set(['', 'HS256', 'RS256', 'RS512', 'PS256'])

/** Auth0 caps an access-token lifetime at 30 days. */
export const TOKEN_LIFETIME_MAX = 2592000

/** One scope (permission) on a resource server. */
export interface Auth0Scope {
  value?: string
  description?: string
}

/** One resource server (API) as returned by the Management API. */
export interface Auth0ResourceServer {
  id?: string
  name?: string
  identifier?: string
  scopes?: Auth0Scope[]
  signing_alg?: string
  token_lifetime?: number
  [key: string]: unknown
}

/** The create body — identifier is only sent when creating (immutable thereafter). */
export interface ResourceServerCreateBody {
  name: string
  identifier: string
  scopes: Auth0Scope[]
  signing_alg?: string
  token_lifetime?: number
}

/** The update body — identifier is omitted (immutable). */
export interface ResourceServerUpdateBody {
  name: string
  scopes: Auth0Scope[]
  signing_alg?: string
  token_lifetime?: number
}

/** Find a live resource server by name (case-sensitive, trimmed) — the upsert identity. */
export function findResourceServerByName(
  list: Auth0ResourceServer[],
  name: string,
): Auth0ResourceServer | null {
  const n = name.trim()
  if (!n) return null
  return list.find((r) => String(r.name ?? '').trim() === n) ?? null
}

/** Project a scopes array to a value → description map (the canvas keyvalue shape). */
export function scopesToMap(scopes: Auth0Scope[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const scope of scopes ?? []) {
    const value = String(scope?.value ?? '').trim()
    if (value) out[value] = String(scope?.description ?? '')
  }
  return out
}

/** Project a value → description map back to Auth0's scopes array shape. */
export function mapToScopes(map: Record<string, string>): Auth0Scope[] {
  return Object.entries(map).map(([value, description]) =>
    description ? { value, description } : { value },
  )
}

function scopesFromFields(fields: Record<string, unknown>): Auth0Scope[] {
  return mapToScopes(readKeyValueMap(fields.scopes))
}

/** Build the create body from canvas fields (name + identifier included). */
export function buildResourceServerCreateBody(fields: Record<string, unknown>): ResourceServerCreateBody {
  const body: ResourceServerCreateBody = {
    name: readString(fields.name),
    identifier: readString(fields.identifier),
    scopes: scopesFromFields(fields),
  }
  const signingAlg = readString(fields.signing_alg)
  if (signingAlg) body.signing_alg = signingAlg
  const tokenLifetime = readOptionalInt(fields.token_lifetime)
  if (tokenLifetime !== undefined) body.token_lifetime = tokenLifetime
  return body
}

/** Build the update body from canvas fields (identifier omitted — immutable). */
export function buildResourceServerUpdateBody(fields: Record<string, unknown>): ResourceServerUpdateBody {
  const body: ResourceServerUpdateBody = {
    name: readString(fields.name),
    scopes: scopesFromFields(fields),
  }
  const signingAlg = readString(fields.signing_alg)
  if (signingAlg) body.signing_alg = signingAlg
  const tokenLifetime = readOptionalInt(fields.token_lifetime)
  if (tokenLifetime !== undefined) body.token_lifetime = tokenLifetime
  return body
}

/** Capture the prior managed state of a live resource server for rollback. */
export function snapshotResourceServer(rs: Auth0ResourceServer): ResourceServerUpdateBody {
  const body: ResourceServerUpdateBody = {
    name: String(rs.name ?? '').trim(),
    scopes: Array.isArray(rs.scopes) ? rs.scopes : [],
  }
  if (typeof rs.signing_alg === 'string' && rs.signing_alg) body.signing_alg = rs.signing_alg
  if (typeof rs.token_lifetime === 'number') body.token_lifetime = rs.token_lifetime
  return body
}
