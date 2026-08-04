// Shared helpers for the Auth0 Client Grants config type (deploy + rollback +
// drift).
//
// A client grant authorizes a Machine-to-Machine Application (client_id) to
// request an access token for an API (audience), with a scope list —
// GET/POST /api/v2/client-grants and PATCH/DELETE /api/v2/client-grants/{id}.
// The Management API keys a grant on the server-assigned `id`; unlike every
// other config type in this app there is no single field that is unique, so
// this config type upserts by the COMPOSITE (client_id, audience) pair (Auth0
// normally allows only one grant per pair). `client_id` and `audience` are set
// at creation and are NOT changed on update, so the PATCH body omits both.
//
// Verified against the official Auth0 Management API v2 (Client Grants):
//   https://auth0.com/docs/api/management/v2/client-grants/post-client-grants
//   https://auth0.com/docs/api/management/v2/client-grants/patch-client-grants-by-id

import { readOptionalString, readString, readStringArray } from '../../lib/fields'

/** Values Auth0 accepts for a grant's organization_usage. "" defers to Auth0's default (deny). */
export const ORGANIZATION_USAGE_VALUES = new Set(['', 'deny', 'allow', 'require'])

/** Parse a checkbox canvas value, falling back when absent (the widget otherwise emits a real boolean). */
function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** One client grant as returned by the Management API. */
export interface Auth0ClientGrant {
  id?: string
  client_id?: string
  audience?: string
  scope?: string[]
  organization_usage?: string
  allow_any_organization?: boolean
  [key: string]: unknown
}

/** The create body — client_id + audience are only sent when creating. */
export interface ClientGrantCreateBody {
  client_id: string
  audience: string
  scope?: string[]
  organization_usage?: string
  allow_any_organization?: boolean
}

/** The update body — client_id and audience are omitted (immutable). */
export interface ClientGrantUpdateBody {
  scope?: string[]
  organization_usage?: string
  allow_any_organization?: boolean
}

/**
 * Stable key for a client grant — identity is the (client_id, audience) tuple,
 * serialized as JSON so the two tokens can never collide regardless of their
 * contents. Mirrors `permKey` in config-types/roles/_shared.ts.
 */
export function grantKey(clientId: string, audience: string): string {
  return JSON.stringify([clientId.trim(), audience.trim()])
}

/** Find a live client grant by (client_id, audience) — the upsert identity. */
export function findClientGrant(
  list: Auth0ClientGrant[],
  clientId: string,
  audience: string,
): Auth0ClientGrant | null {
  if (!clientId.trim() || !audience.trim()) return null
  const key = grantKey(clientId, audience)
  return list.find((g) => grantKey(String(g.client_id ?? ''), String(g.audience ?? '')) === key) ?? null
}

/** Build the create body from canvas fields (client_id + audience included). */
export function buildClientGrantCreateBody(fields: Record<string, unknown>): ClientGrantCreateBody {
  const body: ClientGrantCreateBody = {
    client_id: readString(fields.client_id),
    audience: readString(fields.audience),
  }
  const scope = readStringArray(fields.scope)
  if (scope.length > 0) body.scope = scope
  const orgUsage = readOptionalString(fields.organization_usage)
  if (orgUsage) body.organization_usage = orgUsage
  body.allow_any_organization = readBool(fields.allow_any_organization, false)
  return body
}

/** Build the update body from canvas fields (client_id + audience omitted — immutable). */
export function buildClientGrantUpdateBody(fields: Record<string, unknown>): ClientGrantUpdateBody {
  const body: ClientGrantUpdateBody = {}
  const scope = readStringArray(fields.scope)
  if (scope.length > 0) body.scope = scope
  const orgUsage = readOptionalString(fields.organization_usage)
  if (orgUsage) body.organization_usage = orgUsage
  body.allow_any_organization = readBool(fields.allow_any_organization, false)
  return body
}

/** Capture the prior managed state of a live client grant for rollback. */
export function snapshotClientGrant(grant: Auth0ClientGrant): ClientGrantUpdateBody {
  const body: ClientGrantUpdateBody = {
    scope: Array.isArray(grant.scope) ? grant.scope : [],
    allow_any_organization: typeof grant.allow_any_organization === 'boolean' ? grant.allow_any_organization : false,
  }
  if (typeof grant.organization_usage === 'string' && grant.organization_usage) {
    body.organization_usage = grant.organization_usage
  }
  return body
}
