// Shared helpers for the authentik OAuth2/OpenID Providers config type (deploy +
// rollback + drift). Shapes follow the authentik Core API `OAuth2Provider` /
// `OAuth2ProviderRequest` / `PatchedOAuth2ProviderRequest` schemas — see
// lib/authentikApi.ts for citations.
//
// IDENTITY: unlike Applications/Flows, a provider's API path key is a
// server-assigned integer `pk` (`/providers/oauth2/{id}/`), not a user-declared
// value — so this config type upserts by NAME (list `?name=` → match →
// PATCH/POST), the same pattern the authentikApi `findByName` helper exists for.
//
// The client SECRET (`client_secret`) is never read, sent or diffed by this
// config type — authentik generates/rotates it and it is treated the same way
// Wiz's service-accounts config type treats a generated secret: write-only,
// never captured.
//
// `OAuth2ProviderRequest.required` = [authorization_flow, invalidation_flow,
// name, redirect_uris] per the schema — `invalidation_flow` is required by
// authentik even though it was not called out in the original field list, so
// it is authored here too (a create without it is rejected by authentik).

export const CLIENT_TYPES = new Set(['confidential', 'public'])
export const DEFAULT_CLIENT_TYPE = 'confidential'

/** UUID matcher for the Flow / Certificate-Key-pair pk fields authentik expects. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One entry of `OAuth2Provider.redirect_uris` (the `RedirectURI` schema). */
export interface OAuth2ProviderRedirectUri {
  matching_mode?: 'strict' | 'regex'
  url?: string
  redirect_uri_type?: 'authorization' | 'logout'
}

/** An authentik OAuth2Provider as returned by the Core API (fields this config type reads). */
export interface AuthentikOAuth2Provider {
  pk?: number
  name?: string
  authorization_flow?: string
  invalidation_flow?: string
  client_type?: string
  client_id?: string
  signing_key?: string | null
  redirect_uris?: OAuth2ProviderRedirectUri[]
  property_mappings?: string[]
  [key: string]: unknown
}

/** The subset of OAuth2Provider fields this config type authors (never `client_secret`). */
export interface ManagedOAuth2ProviderFields {
  name: string
  authorizationFlow: string
  invalidationFlow: string
  clientType: string
  clientId: string
  signingKey: string
  redirectUrls: string[]
  propertyMappings: string[]
}

/** Read a newline/comma-separated list (or a `tags` array), trimmed and de-duplicated. */
export function readStringList(value: unknown): string[] {
  const raw: string[] = Array.isArray(value) ? value.map((v) => String(v ?? '')) : String(value ?? '').split(/[\r\n,]+/)
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const trimmed = entry.trim()
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed)
      out.push(trimmed)
    }
  }
  return out
}

/** Two string lists are equal as sets (order-insensitive, assumes de-duped). */
export function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setB = new Set(b)
  return a.every((v) => setB.has(v))
}

/** Read the managed fields out of one canvas item's flat `fields` record. */
export function readManagedFields(fields: Record<string, unknown>): ManagedOAuth2ProviderFields {
  const clientType = String(fields.client_type ?? '').trim()
  return {
    name: String(fields.name ?? '').trim(),
    authorizationFlow: String(fields.authorization_flow ?? '').trim(),
    invalidationFlow: String(fields.invalidation_flow ?? '').trim(),
    clientType: CLIENT_TYPES.has(clientType) ? clientType : DEFAULT_CLIENT_TYPE,
    clientId: String(fields.client_id ?? '').trim(),
    signingKey: String(fields.signing_key ?? '').trim(),
    redirectUrls: readStringList(fields.redirect_uris),
    propertyMappings: readStringList(fields.property_mappings),
  }
}

/**
 * The managed-field projection shared by create (POST) and update (PATCH).
 * `client_id` / `signing_key` / `property_mappings` are only included when
 * declared, so a PATCH leaves an unmanaged or authentik-defaulted value
 * (e.g. an auto-generated client_id) untouched rather than clearing it.
 */
function buildManagedBody(managed: ManagedOAuth2ProviderFields): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: managed.name,
    authorization_flow: managed.authorizationFlow,
    invalidation_flow: managed.invalidationFlow,
    client_type: managed.clientType,
    redirect_uris: managed.redirectUrls.map((url) => ({
      matching_mode: 'strict',
      url,
      redirect_uri_type: 'authorization',
    })),
  }
  if (managed.clientId) body.client_id = managed.clientId
  if (managed.signingKey) body.signing_key = managed.signingKey
  if (managed.propertyMappings.length > 0) body.property_mappings = managed.propertyMappings
  return body
}

export function buildCreateBody(fields: Record<string, unknown>): Record<string, unknown> {
  return buildManagedBody(readManagedFields(fields))
}

export function buildPatchBody(fields: Record<string, unknown>): Record<string, unknown> {
  return buildManagedBody(readManagedFields(fields))
}

/** Build a PATCH body directly from a captured `ManagedOAuth2ProviderFields` snapshot (rollback restore). */
export function managedFieldsToPatchBody(managed: ManagedOAuth2ProviderFields): Record<string, unknown> {
  return buildManagedBody(managed)
}

function redirectUrlsOf(provider: AuthentikOAuth2Provider): string[] {
  return Array.isArray(provider.redirect_uris)
    ? provider.redirect_uris.map((r) => String(r?.url ?? '')).filter((u) => u.length > 0)
    : []
}

/** Snapshot the managed fields off a LIVE provider, for rollback restore / drift comparison. */
export function snapshotManagedFields(provider: AuthentikOAuth2Provider): ManagedOAuth2ProviderFields {
  const clientType = String(provider.client_type ?? '').trim()
  return {
    name: String(provider.name ?? '').trim(),
    authorizationFlow: String(provider.authorization_flow ?? '').trim(),
    invalidationFlow: String(provider.invalidation_flow ?? '').trim(),
    clientType: CLIENT_TYPES.has(clientType) ? clientType : DEFAULT_CLIENT_TYPE,
    clientId: String(provider.client_id ?? '').trim(),
    signingKey: String(provider.signing_key ?? '').trim(),
    redirectUrls: redirectUrlsOf(provider),
    propertyMappings: Array.isArray(provider.property_mappings) ? provider.property_mappings.map(String) : [],
  }
}

/**
 * True when the two managed-field snapshots are equal. `clientId` / `signingKey`
 * / `propertyMappings` are only compared when OUR declared spec set a value —
 * left blank means we deliberately don't manage that field (see buildManagedBody),
 * so a live value there is not drift.
 */
export function sameManagedFields(expected: ManagedOAuth2ProviderFields, actual: ManagedOAuth2ProviderFields): boolean {
  if (expected.name !== actual.name) return false
  if (expected.authorizationFlow !== actual.authorizationFlow) return false
  if (expected.invalidationFlow !== actual.invalidationFlow) return false
  if (expected.clientType !== actual.clientType) return false
  if (expected.clientId && expected.clientId !== actual.clientId) return false
  if (expected.signingKey && expected.signingKey !== actual.signingKey) return false
  if (!sameStringSet(expected.redirectUrls, actual.redirectUrls)) return false
  if (expected.propertyMappings.length > 0 && !sameStringSet(expected.propertyMappings, actual.propertyMappings)) return false
  return true
}
