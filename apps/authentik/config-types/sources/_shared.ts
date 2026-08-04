// Shared helpers for the authentik Sources config type (deploy + rollback +
// drift). Covers two genuinely distinct authentik models, each with its own
// endpoint and Request schema — see lib/authentikApi.ts for citations:
//   oauth   OAuthSource / OAuthSourceRequest   /sources/oauth/
//   ldap    LDAPSource / LDAPSourceRequest     /sources/ldap/
//
// IDENTITY: like Applications/Flows, a source's `slug` IS its API path key —
// this config type retrieves by identity directly within the item's selected
// type's endpoint (GET .../{slug}/ → 200/404 → PATCH/POST).
//
// SECRETS ARE WRITE-ONLY: `consumer_secret` / `bind_password` are never read
// back (authentik's schema marks them `writeOnly: true` — a GET never
// includes them). They are sent only when the canvas item declares a
// non-blank value; snapshots/diffs never include them.

export const SOURCE_TYPES = new Set(['oauth', 'ldap'])
export type SourceType = 'oauth' | 'ldap'

/** The `/sources/<segment>/` path segment for each type. */
export const SOURCE_ENDPOINT_SEGMENT: Record<SourceType, string> = {
  oauth: 'oauth',
  ldap: 'ldap',
}

export const PROVIDER_TYPES = new Set([
  'openidconnect', 'apple', 'discord', 'entraid', 'facebook', 'github', 'gitlab',
  'google', 'mailcow', 'okta', 'patreon', 'reddit', 'slack', 'twitch', 'twitter', 'wechat',
])

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const SLUG_PATTERN = /^[-a-zA-Z0-9_]+$/

export interface AuthentikSource {
  pk?: string
  name?: string
  slug?: string
  enabled?: boolean
  authentication_flow?: string | null
  enrollment_flow?: string | null
  provider_type?: string
  consumer_key?: string
  authorization_url?: string | null
  access_token_url?: string | null
  profile_url?: string | null
  oidc_well_known_url?: string
  server_uri?: string
  bind_cn?: string
  base_dn?: string
  start_tls?: boolean
  [key: string]: unknown
}

export interface ManagedSourceFields {
  name: string
  slug: string
  type: SourceType
  enabled: boolean
  authenticationFlow: string
  enrollmentFlow: string
  // oauth
  providerType: string
  consumerKey: string
  consumerSecret: string
  authorizationUrl: string
  accessTokenUrl: string
  profileUrl: string
  oidcWellKnownUrl: string
  // ldap
  serverUri: string
  bindCn: string
  bindPassword: string
  baseDn: string
  startTls: boolean
}

export function normalizeBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (value == null) return fallback
  const s = String(value).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false
  return fallback
}

export function readSourceType(value: unknown): SourceType {
  const t = String(value ?? '').trim()
  return SOURCE_TYPES.has(t) ? (t as SourceType) : 'oauth'
}

export function readManagedFields(fields: Record<string, unknown>): ManagedSourceFields {
  const providerType = String(fields.provider_type ?? '').trim()
  return {
    name: String(fields.name ?? '').trim(),
    slug: String(fields.slug ?? '').trim(),
    type: readSourceType(fields.type),
    enabled: normalizeBool(fields.enabled, true),
    authenticationFlow: String(fields.authentication_flow ?? '').trim(),
    enrollmentFlow: String(fields.enrollment_flow ?? '').trim(),
    providerType: PROVIDER_TYPES.has(providerType) ? providerType : 'openidconnect',
    consumerKey: String(fields.consumer_key ?? '').trim(),
    consumerSecret: String(fields.consumer_secret ?? ''),
    authorizationUrl: String(fields.authorization_url ?? '').trim(),
    accessTokenUrl: String(fields.access_token_url ?? '').trim(),
    profileUrl: String(fields.profile_url ?? '').trim(),
    oidcWellKnownUrl: String(fields.oidc_well_known_url ?? '').trim(),
    serverUri: String(fields.server_uri ?? '').trim(),
    bindCn: String(fields.bind_cn ?? '').trim(),
    bindPassword: String(fields.bind_password ?? ''),
    baseDn: String(fields.base_dn ?? '').trim(),
    startTls: normalizeBool(fields.start_tls, false),
  }
}

/**
 * Build the request body for the item's SELECTED type only. `consumer_secret`
 * / `bind_password` are only included when declared non-blank (write-only —
 * see module docs); optional flow/URL fields are only included when declared.
 */
function buildManagedBody(managed: ManagedSourceFields, includeSlug: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: managed.name,
    enabled: managed.enabled,
  }
  if (includeSlug) body.slug = managed.slug
  if (managed.authenticationFlow) body.authentication_flow = managed.authenticationFlow
  if (managed.enrollmentFlow) body.enrollment_flow = managed.enrollmentFlow

  if (managed.type === 'oauth') {
    body.provider_type = managed.providerType
    if (managed.consumerKey) body.consumer_key = managed.consumerKey
    if (managed.consumerSecret) body.consumer_secret = managed.consumerSecret
    if (managed.authorizationUrl) body.authorization_url = managed.authorizationUrl
    if (managed.accessTokenUrl) body.access_token_url = managed.accessTokenUrl
    if (managed.profileUrl) body.profile_url = managed.profileUrl
    if (managed.oidcWellKnownUrl) body.oidc_well_known_url = managed.oidcWellKnownUrl
    return body
  }
  // ldap
  if (managed.serverUri) body.server_uri = managed.serverUri
  if (managed.bindCn) body.bind_cn = managed.bindCn
  if (managed.bindPassword) body.bind_password = managed.bindPassword
  if (managed.baseDn) body.base_dn = managed.baseDn
  body.start_tls = managed.startTls
  return body
}

/** Build the POST body (`*SourceRequest`) — includes the immutable `slug`. */
export function buildCreateBody(fields: Record<string, unknown>): Record<string, unknown> {
  return buildManagedBody(readManagedFields(fields), true)
}
/** Build the PATCH body (`Patched*SourceRequest`) — `slug` is never sent. */
export function buildPatchBody(fields: Record<string, unknown>): Record<string, unknown> {
  return buildManagedBody(readManagedFields(fields), false)
}
export function managedFieldsToPatchBody(managed: ManagedSourceFields): Record<string, unknown> {
  return buildManagedBody(managed, false)
}

/** Snapshot a live source into the SAME shape as `readManagedFields`, for the given type. Never carries a secret. */
export function snapshotManagedFields(source: AuthentikSource, type: SourceType): ManagedSourceFields {
  const providerType = String(source.provider_type ?? '').trim()
  return {
    name: String(source.name ?? '').trim(),
    slug: String(source.slug ?? '').trim(),
    type,
    enabled: normalizeBool(source.enabled, true),
    authenticationFlow: String(source.authentication_flow ?? '').trim(),
    enrollmentFlow: String(source.enrollment_flow ?? '').trim(),
    providerType: PROVIDER_TYPES.has(providerType) ? providerType : 'openidconnect',
    consumerKey: String(source.consumer_key ?? '').trim(),
    consumerSecret: '', // write-only — never returned by the API
    authorizationUrl: String(source.authorization_url ?? '').trim(),
    accessTokenUrl: String(source.access_token_url ?? '').trim(),
    profileUrl: String(source.profile_url ?? '').trim(),
    oidcWellKnownUrl: String(source.oidc_well_known_url ?? '').trim(),
    serverUri: String(source.server_uri ?? '').trim(),
    bindCn: String(source.bind_cn ?? '').trim(),
    bindPassword: '', // write-only — never returned by the API
    baseDn: String(source.base_dn ?? '').trim(),
    startTls: normalizeBool(source.start_tls, false),
  }
}

/** Compare managed fields. Secret fields are NEVER compared (write-only, never read back). */
export function sameManagedFields(expected: ManagedSourceFields, actual: ManagedSourceFields): boolean {
  if (expected.name !== actual.name) return false
  if (expected.slug !== actual.slug) return false
  if (expected.enabled !== actual.enabled) return false
  if (expected.authenticationFlow && expected.authenticationFlow !== actual.authenticationFlow) return false
  if (expected.enrollmentFlow && expected.enrollmentFlow !== actual.enrollmentFlow) return false

  if (expected.type === 'oauth') {
    if (expected.providerType !== actual.providerType) return false
    if (expected.consumerKey && expected.consumerKey !== actual.consumerKey) return false
    if (expected.authorizationUrl && expected.authorizationUrl !== actual.authorizationUrl) return false
    if (expected.accessTokenUrl && expected.accessTokenUrl !== actual.accessTokenUrl) return false
    if (expected.profileUrl && expected.profileUrl !== actual.profileUrl) return false
    if (expected.oidcWellKnownUrl && expected.oidcWellKnownUrl !== actual.oidcWellKnownUrl) return false
    return true
  }
  // ldap
  if (expected.serverUri && expected.serverUri !== actual.serverUri) return false
  if (expected.bindCn && expected.bindCn !== actual.bindCn) return false
  if (expected.baseDn && expected.baseDn !== actual.baseDn) return false
  if (expected.startTls !== actual.startTls) return false
  return true
}
