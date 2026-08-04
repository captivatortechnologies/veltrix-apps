// Shared helpers for the authentik Proxy Providers config type (deploy +
// rollback + drift). Shapes follow the authentik Core API `ProxyProvider` /
// `ProxyProviderRequest` / `PatchedProxyProviderRequest` schemas — see
// lib/authentikApi.ts for citations.
//
// IDENTITY: like OAuth2/OpenID Providers, a proxy provider's API path key is a
// server-assigned integer `pk` (`/providers/proxy/{id}/`) — this config type
// upserts by NAME (list `?name=` → match → PATCH/POST).

export const PROXY_MODES = new Set(['proxy', 'forward_single', 'forward_domain'])
export const DEFAULT_PROXY_MODE = 'proxy'

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface AuthentikProxyProvider {
  pk?: number
  name?: string
  authorization_flow?: string
  invalidation_flow?: string
  mode?: string
  internal_host?: string
  external_host?: string
  internal_host_ssl_validation?: boolean
  skip_path_regex?: string
  basic_auth_enabled?: boolean
  cookie_domain?: string
  property_mappings?: string[]
  [key: string]: unknown
}

export interface ManagedProxyProviderFields {
  name: string
  authorizationFlow: string
  invalidationFlow: string
  mode: string
  internalHost: string
  externalHost: string
  internalHostSslValidation: boolean
  skipPathRegex: string
  basicAuthEnabled: boolean
  cookieDomain: string
  propertyMappings: string[]
}

export function normalizeBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (value == null) return fallback
  const s = String(value).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false
  return fallback
}

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

export function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setB = new Set(b)
  return a.every((v) => setB.has(v))
}

export function readManagedFields(fields: Record<string, unknown>): ManagedProxyProviderFields {
  const mode = String(fields.mode ?? '').trim()
  return {
    name: String(fields.name ?? '').trim(),
    authorizationFlow: String(fields.authorization_flow ?? '').trim(),
    invalidationFlow: String(fields.invalidation_flow ?? '').trim(),
    mode: PROXY_MODES.has(mode) ? mode : DEFAULT_PROXY_MODE,
    internalHost: String(fields.internal_host ?? '').trim(),
    externalHost: String(fields.external_host ?? '').trim(),
    internalHostSslValidation: normalizeBool(fields.internal_host_ssl_validation, true),
    skipPathRegex: String(fields.skip_path_regex ?? '').trim(),
    basicAuthEnabled: normalizeBool(fields.basic_auth_enabled, false),
    cookieDomain: String(fields.cookie_domain ?? '').trim(),
    propertyMappings: readStringList(fields.property_mappings),
  }
}

/**
 * Managed body shared by create/update. `internal_host` is only sent when
 * declared (blank in forwardAuth modes, where it does not apply);
 * `property_mappings`/`cookie_domain` are only sent when declared.
 */
function buildManagedBody(managed: ManagedProxyProviderFields): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: managed.name,
    authorization_flow: managed.authorizationFlow,
    invalidation_flow: managed.invalidationFlow,
    mode: managed.mode,
    external_host: managed.externalHost,
    internal_host_ssl_validation: managed.internalHostSslValidation,
    basic_auth_enabled: managed.basicAuthEnabled,
  }
  if (managed.internalHost) body.internal_host = managed.internalHost
  if (managed.skipPathRegex) body.skip_path_regex = managed.skipPathRegex
  if (managed.cookieDomain) body.cookie_domain = managed.cookieDomain
  if (managed.propertyMappings.length > 0) body.property_mappings = managed.propertyMappings
  return body
}

export function buildCreateBody(fields: Record<string, unknown>): Record<string, unknown> {
  return buildManagedBody(readManagedFields(fields))
}
export function buildPatchBody(fields: Record<string, unknown>): Record<string, unknown> {
  return buildManagedBody(readManagedFields(fields))
}
export function managedFieldsToPatchBody(managed: ManagedProxyProviderFields): Record<string, unknown> {
  return buildManagedBody(managed)
}

export function snapshotManagedFields(provider: AuthentikProxyProvider): ManagedProxyProviderFields {
  const mode = String(provider.mode ?? '').trim()
  return {
    name: String(provider.name ?? '').trim(),
    authorizationFlow: String(provider.authorization_flow ?? '').trim(),
    invalidationFlow: String(provider.invalidation_flow ?? '').trim(),
    mode: PROXY_MODES.has(mode) ? mode : DEFAULT_PROXY_MODE,
    internalHost: String(provider.internal_host ?? '').trim(),
    externalHost: String(provider.external_host ?? '').trim(),
    internalHostSslValidation: normalizeBool(provider.internal_host_ssl_validation, true),
    skipPathRegex: String(provider.skip_path_regex ?? '').trim(),
    basicAuthEnabled: normalizeBool(provider.basic_auth_enabled, false),
    cookieDomain: String(provider.cookie_domain ?? '').trim(),
    propertyMappings: Array.isArray(provider.property_mappings) ? provider.property_mappings.map(String) : [],
  }
}

export function sameManagedFields(expected: ManagedProxyProviderFields, actual: ManagedProxyProviderFields): boolean {
  if (expected.name !== actual.name) return false
  if (expected.authorizationFlow !== actual.authorizationFlow) return false
  if (expected.invalidationFlow !== actual.invalidationFlow) return false
  if (expected.mode !== actual.mode) return false
  if (expected.internalHost && expected.internalHost !== actual.internalHost) return false
  if (expected.externalHost !== actual.externalHost) return false
  if (expected.internalHostSslValidation !== actual.internalHostSslValidation) return false
  if (expected.skipPathRegex && expected.skipPathRegex !== actual.skipPathRegex) return false
  if (expected.basicAuthEnabled !== actual.basicAuthEnabled) return false
  if (expected.cookieDomain && expected.cookieDomain !== actual.cookieDomain) return false
  if (expected.propertyMappings.length > 0 && !sameStringSet(expected.propertyMappings, actual.propertyMappings)) return false
  return true
}
