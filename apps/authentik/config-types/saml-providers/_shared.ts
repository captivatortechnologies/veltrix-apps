// Shared helpers for the authentik SAML Providers config type (deploy +
// rollback + drift). Shapes follow the authentik Core API `SAMLProvider` /
// `SAMLProviderRequest` / `PatchedSAMLProviderRequest` schemas — see
// lib/authentikApi.ts for citations.
//
// IDENTITY: like OAuth2/OpenID Providers, a SAML provider's API path key is a
// server-assigned integer `pk` (`/providers/saml/{id}/`) — this config type
// upserts by NAME (list `?name=` → match → PATCH/POST).

export const SP_BINDINGS = new Set(['redirect', 'post'])
export const DEFAULT_SP_BINDING = 'redirect'

/** UUID matcher for the Flow / property-mapping pk fields authentik expects. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface AuthentikSAMLProvider {
  pk?: number
  name?: string
  authorization_flow?: string
  invalidation_flow?: string
  acs_url?: string
  audience?: string
  sp_binding?: string
  sign_assertion?: boolean
  sign_response?: boolean
  property_mappings?: string[]
  [key: string]: unknown
}

export interface ManagedSAMLProviderFields {
  name: string
  authorizationFlow: string
  invalidationFlow: string
  acsUrl: string
  audience: string
  spBinding: string
  signAssertion: boolean
  signResponse: boolean
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

export function readManagedFields(fields: Record<string, unknown>): ManagedSAMLProviderFields {
  const spBinding = String(fields.sp_binding ?? '').trim()
  return {
    name: String(fields.name ?? '').trim(),
    authorizationFlow: String(fields.authorization_flow ?? '').trim(),
    invalidationFlow: String(fields.invalidation_flow ?? '').trim(),
    acsUrl: String(fields.acs_url ?? '').trim(),
    audience: String(fields.audience ?? '').trim(),
    spBinding: SP_BINDINGS.has(spBinding) ? spBinding : DEFAULT_SP_BINDING,
    signAssertion: normalizeBool(fields.sign_assertion, false),
    signResponse: normalizeBool(fields.sign_response, false),
    propertyMappings: readStringList(fields.property_mappings),
  }
}

/** Managed body shared by create/update. `property_mappings` is only sent when declared. */
function buildManagedBody(managed: ManagedSAMLProviderFields): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: managed.name,
    authorization_flow: managed.authorizationFlow,
    invalidation_flow: managed.invalidationFlow,
    acs_url: managed.acsUrl,
    audience: managed.audience,
    sp_binding: managed.spBinding,
    sign_assertion: managed.signAssertion,
    sign_response: managed.signResponse,
  }
  if (managed.propertyMappings.length > 0) body.property_mappings = managed.propertyMappings
  return body
}

export function buildCreateBody(fields: Record<string, unknown>): Record<string, unknown> {
  return buildManagedBody(readManagedFields(fields))
}
export function buildPatchBody(fields: Record<string, unknown>): Record<string, unknown> {
  return buildManagedBody(readManagedFields(fields))
}
export function managedFieldsToPatchBody(managed: ManagedSAMLProviderFields): Record<string, unknown> {
  return buildManagedBody(managed)
}

export function snapshotManagedFields(provider: AuthentikSAMLProvider): ManagedSAMLProviderFields {
  const spBinding = String(provider.sp_binding ?? '').trim()
  return {
    name: String(provider.name ?? '').trim(),
    authorizationFlow: String(provider.authorization_flow ?? '').trim(),
    invalidationFlow: String(provider.invalidation_flow ?? '').trim(),
    acsUrl: String(provider.acs_url ?? '').trim(),
    audience: String(provider.audience ?? '').trim(),
    spBinding: SP_BINDINGS.has(spBinding) ? spBinding : DEFAULT_SP_BINDING,
    signAssertion: normalizeBool(provider.sign_assertion, false),
    signResponse: normalizeBool(provider.sign_response, false),
    propertyMappings: Array.isArray(provider.property_mappings) ? provider.property_mappings.map(String) : [],
  }
}

export function sameManagedFields(expected: ManagedSAMLProviderFields, actual: ManagedSAMLProviderFields): boolean {
  if (expected.name !== actual.name) return false
  if (expected.authorizationFlow !== actual.authorizationFlow) return false
  if (expected.invalidationFlow !== actual.invalidationFlow) return false
  if (expected.acsUrl !== actual.acsUrl) return false
  if (expected.audience !== actual.audience) return false
  if (expected.spBinding !== actual.spBinding) return false
  if (expected.signAssertion !== actual.signAssertion) return false
  if (expected.signResponse !== actual.signResponse) return false
  if (expected.propertyMappings.length > 0 && !sameStringSet(expected.propertyMappings, actual.propertyMappings)) return false
  return true
}
