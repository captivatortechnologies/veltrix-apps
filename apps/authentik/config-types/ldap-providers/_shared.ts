// Shared helpers for the authentik LDAP Providers config type (deploy +
// rollback + drift). Shapes follow the authentik Core API `LDAPProvider` /
// `LDAPProviderRequest` / `PatchedLDAPProviderRequest` schemas — see
// lib/authentikApi.ts for citations.
//
// IDENTITY: like OAuth2/OpenID Providers, an LDAP provider's API path key is a
// server-assigned integer `pk` (`/providers/ldap/{id}/`) — this config type
// upserts by NAME (list `?name=` → match → PATCH/POST).

export const LDAP_ACCESS_MODES = new Set(['direct', 'cached'])
export const DEFAULT_ACCESS_MODE = 'direct'

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface AuthentikLDAPProvider {
  pk?: number
  name?: string
  authorization_flow?: string
  invalidation_flow?: string
  base_dn?: string
  uid_start_number?: number
  gid_start_number?: number
  search_mode?: string
  bind_mode?: string
  mfa_support?: boolean
  property_mappings?: string[]
  [key: string]: unknown
}

export interface ManagedLDAPProviderFields {
  name: string
  authorizationFlow: string
  invalidationFlow: string
  baseDn: string
  uidStartNumber: number | null
  gidStartNumber: number | null
  searchMode: string
  bindMode: string
  mfaSupport: boolean
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

export function readOptionalInt(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isFinite(n) ? Math.trunc(n) : null
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

export function readManagedFields(fields: Record<string, unknown>): ManagedLDAPProviderFields {
  const searchMode = String(fields.search_mode ?? '').trim()
  const bindMode = String(fields.bind_mode ?? '').trim()
  return {
    name: String(fields.name ?? '').trim(),
    authorizationFlow: String(fields.authorization_flow ?? '').trim(),
    invalidationFlow: String(fields.invalidation_flow ?? '').trim(),
    baseDn: String(fields.base_dn ?? '').trim(),
    uidStartNumber: readOptionalInt(fields.uid_start_number),
    gidStartNumber: readOptionalInt(fields.gid_start_number),
    searchMode: LDAP_ACCESS_MODES.has(searchMode) ? searchMode : DEFAULT_ACCESS_MODE,
    bindMode: LDAP_ACCESS_MODES.has(bindMode) ? bindMode : DEFAULT_ACCESS_MODE,
    mfaSupport: normalizeBool(fields.mfa_support, false),
    propertyMappings: readStringList(fields.property_mappings),
  }
}

/** Managed body shared by create/update. Numeric start numbers + property_mappings are only sent when declared. */
function buildManagedBody(managed: ManagedLDAPProviderFields): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: managed.name,
    authorization_flow: managed.authorizationFlow,
    invalidation_flow: managed.invalidationFlow,
    base_dn: managed.baseDn,
    search_mode: managed.searchMode,
    bind_mode: managed.bindMode,
    mfa_support: managed.mfaSupport,
  }
  if (managed.uidStartNumber != null) body.uid_start_number = managed.uidStartNumber
  if (managed.gidStartNumber != null) body.gid_start_number = managed.gidStartNumber
  if (managed.propertyMappings.length > 0) body.property_mappings = managed.propertyMappings
  return body
}

export function buildCreateBody(fields: Record<string, unknown>): Record<string, unknown> {
  return buildManagedBody(readManagedFields(fields))
}
export function buildPatchBody(fields: Record<string, unknown>): Record<string, unknown> {
  return buildManagedBody(readManagedFields(fields))
}
export function managedFieldsToPatchBody(managed: ManagedLDAPProviderFields): Record<string, unknown> {
  return buildManagedBody(managed)
}

export function snapshotManagedFields(provider: AuthentikLDAPProvider): ManagedLDAPProviderFields {
  const searchMode = String(provider.search_mode ?? '').trim()
  const bindMode = String(provider.bind_mode ?? '').trim()
  return {
    name: String(provider.name ?? '').trim(),
    authorizationFlow: String(provider.authorization_flow ?? '').trim(),
    invalidationFlow: String(provider.invalidation_flow ?? '').trim(),
    baseDn: String(provider.base_dn ?? '').trim(),
    uidStartNumber: typeof provider.uid_start_number === 'number' ? provider.uid_start_number : null,
    gidStartNumber: typeof provider.gid_start_number === 'number' ? provider.gid_start_number : null,
    searchMode: LDAP_ACCESS_MODES.has(searchMode) ? searchMode : DEFAULT_ACCESS_MODE,
    bindMode: LDAP_ACCESS_MODES.has(bindMode) ? bindMode : DEFAULT_ACCESS_MODE,
    mfaSupport: normalizeBool(provider.mfa_support, false),
    propertyMappings: Array.isArray(provider.property_mappings) ? provider.property_mappings.map(String) : [],
  }
}

export function sameManagedFields(expected: ManagedLDAPProviderFields, actual: ManagedLDAPProviderFields): boolean {
  if (expected.name !== actual.name) return false
  if (expected.authorizationFlow !== actual.authorizationFlow) return false
  if (expected.invalidationFlow !== actual.invalidationFlow) return false
  if (expected.baseDn !== actual.baseDn) return false
  if (expected.uidStartNumber != null && expected.uidStartNumber !== actual.uidStartNumber) return false
  if (expected.gidStartNumber != null && expected.gidStartNumber !== actual.gidStartNumber) return false
  if (expected.searchMode !== actual.searchMode) return false
  if (expected.bindMode !== actual.bindMode) return false
  if (expected.mfaSupport !== actual.mfaSupport) return false
  if (expected.propertyMappings.length > 0 && !sameStringSet(expected.propertyMappings, actual.propertyMappings)) return false
  return true
}
