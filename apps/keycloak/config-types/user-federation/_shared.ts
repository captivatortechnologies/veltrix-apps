// Shared helpers for the Keycloak User Federation config type (deploy +
// rollback + drift). Covers LDAP and standalone Kerberos user-storage
// providers — both are Keycloak "Component" objects:
//   ComponentRepresentation { id, name, providerId, providerType, parentId, config }
// `providerType` is always the fixed string org.keycloak.storage.UserStorageProvider
// for both; `providerId` ("ldap" | "kerberos") is the type discriminator.
//
// VERIFIED against Keycloak's ComponentRepresentation.java source: `config` is a
// MultivaluedHashMap<String,String> — every value on the wire is a STRING ARRAY,
// even single-valued settings (e.g. `{"enabled": ["true"]}`, not `{"enabled":
// "true"}`). Unlike IdentityProviderRepresentation/GroupRepresentation, a
// component has NO dedicated top-level `enabled`/`priority` fields — those are
// themselves config entries (UserStorageProviderModel reads/writes them via
// getConfig().getFirst("enabled") / ("priority")), so this config type folds
// them into the same flat-config pipeline as every other managed setting.
//
// Endpoints (all under the realm admin base):
//   realm id:  GET    /admin/realms/{realm}                                    → .id (used as parentId)
//   list:      GET    /components?parentId={realmId}&type=<providerType>       → ComponentRepresentation[]
//   create:    POST   /components
//   update:    PUT    /components/{id}
//   delete:    DELETE /components/{id}
// There is no name filter on the list endpoint, so this config type upserts by
// list + client-side exact match on `name` — the same shape as the groups
// config type's findGroupByName.
//
// SECRETS ARE WRITE-ONLY. `bindCredential` (LDAP bind password) and `keyTab`
// (Kerberos keytab path/content) are never read back: Keycloak masks a
// confidential config value on GET as the literal string "**********"
// (ComponentRepresentation.SECRET_VALUE). They are sent only when the canvas
// item declares a non-blank value; drift never compares them; rollback never
// restores a masked value over a live secret — see stripSecretsFromComponent
// below for the specific rule this config type applies to keep that true.

import { readBool, readString, readStringArray } from '../../lib/fields'

/** Fixed providerType for every user-storage component (LDAP and Kerberos alike). */
export const USER_STORAGE_PROVIDER_TYPE = 'org.keycloak.storage.UserStorageProvider'

export type FederationProviderId = 'ldap' | 'kerberos'
export const FEDERATION_PROVIDER_IDS = new Set<FederationProviderId>(['ldap', 'kerberos'])

export const EDIT_MODES = new Set(['READ_ONLY', 'WRITABLE', 'UNSYNCED'])
/**
 * VERIFIED against Keycloak's LDAPConstants.java source
 * (VENDOR_OTHER="other", VENDOR_NOVELL_EDIRECTORY="edirectory",
 * VENDOR_ACTIVE_DIRECTORY="ad", VENDOR_RHDS="rhds", VENDOR_TIVOLI="tivoli") —
 * all lower-case on the wire.
 */
export const LDAP_VENDORS = new Set(['other', 'edirectory', 'ad', 'rhds', 'tivoli'])
export const AUTH_TYPES = new Set(['simple', 'none'])
/**
 * VERIFIED against Keycloak's LDAPConfig.java source: `getSearchScope()` does
 * `Integer.parseInt(config.getFirst(LDAPConstants.SEARCH_SCOPE))` against
 * javax.naming.directory.SearchControls's numeric constants — the wire value
 * is the numeric STRING "1" (ONELEVEL_SCOPE) or "2" (SUBTREE_SCOPE), not the
 * word.
 */
export const SEARCH_SCOPES = new Set(['1', '2'])

/** The two secret-bearing config keys — write-only, explicit membership (25+ keys live here; explicit reads clearer than a regex). */
export const SECRET_CONFIG_KEYS = new Set(['bindCredential', 'keyTab'])

/** The literal placeholder Keycloak returns on GET for a masked confidential config value. */
export const MASKED_SECRET_VALUE = '**********'

/** A user-storage component as returned by GET /admin/realms/{realm}/components. */
export interface KeycloakComponentRep {
  /** Internal UUID — the {id} path segment for PUT/DELETE .../components/{id}. */
  id?: string
  /** The component name — this config type's identity (matched client-side). */
  name?: string
  /** "ldap" | "kerberos" — the type discriminator. */
  providerId?: string
  /** Always org.keycloak.storage.UserStorageProvider for this config type. */
  providerType?: string
  /** The realm's own internal id (NOT necessarily the realm name string). */
  parentId?: string
  /** Every value is a string array on the wire, even single-valued settings. */
  config?: Record<string, string[]>
  [key: string]: unknown
}

/** Find a component by its exact name (the stable identity). */
export function findComponentByName(components: KeycloakComponentRep[], name: string): KeycloakComponentRep | null {
  const target = name.trim()
  if (!target) return null
  return components.find((c) => String(c.name ?? '').trim() === target) ?? null
}

/** Wrap a flat string map into Keycloak's config Map<String, List<String>> shape (one value per key). */
export function toComponentConfig(map: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(map)) out[key] = [value]
  return out
}

/** Flatten Keycloak's config Map<String, List<String>> to a first-value flat map. */
export function fromComponentConfig(config: Record<string, string[]> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!config) return out
  for (const [key, list] of Object.entries(config)) {
    if (Array.isArray(list) && list.length > 0) out[key] = String(list[0])
  }
  return out
}

/**
 * Keycloak stores the multi-valued LDAP "User object classes" setting as ONE
 * comma-and-space-joined string in a single-element config array (e.g.
 * `config.userObjectClasses = ["inetOrgPerson, organizationalPerson"]`), not
 * as a genuine multi-element array. Join/split at this boundary only.
 */
export function joinUserObjectClasses(classes: string[]): string {
  return classes.join(', ')
}
export function splitUserObjectClasses(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Drop secret-bearing keys from a FLAT config map — used for drift comparison (never assert drift on a secret; Keycloak returns it masked). */
export function nonSecretConfig(config: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(config)) {
    if (!SECRET_CONFIG_KEYS.has(key)) out[key] = value
  }
  return out
}

/**
 * Drop secret-bearing keys from a component's RAW (multi-valued) config.
 *
 * DESIGN DECISION — why this exists and why it matters for rollback:
 * deploy.ts captures the live component it is about to overwrite into
 * rollbackData so rollback can PUT it back. But Keycloak's GET response for an
 * EXISTING component returns "**********" (MASKED_SECRET_VALUE) for
 * bindCredential/keyTab, never the real value. If that captured body were
 * stored and later PUT back verbatim by rollback, it would overwrite the LIVE
 * secret with the literal masked placeholder string — corrupting it. So every
 * "prior" body this config type captures for rollback (and every "base" body
 * an update merges over) has its secret keys stripped out entirely here,
 * rather than risk ever writing that placeholder as if it were real.
 *
 * ASSUMPTION TO VERIFY against a live Keycloak: PUT /components/{id} is
 * assumed to leave an omitted config key untouched (rather than clearing it),
 * which is what makes "just don't mention bindCredential/keyTab in the body"
 * a safe way to leave the live secret alone. If a live Keycloak instead clears
 * an omitted key, both an update that doesn't rotate the secret and a
 * rollback would end up wiping it — the conservative stripping behavior here
 * is still the safer of the two failure modes (never writes a corrupt literal
 * placeholder), but this should be confirmed before depending on it in
 * production.
 */
export function stripSecretsFromComponent(component: KeycloakComponentRep): KeycloakComponentRep {
  if (!component.config) return { ...component }
  const config: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(component.config)) {
    if (!SECRET_CONFIG_KEYS.has(key)) config[key] = value
  }
  return { ...component, config }
}

// --- Field reading -------------------------------------------------------

function readNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return fallback
}

function readOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/**
 * Default only when blank — an invalid-but-non-blank value is returned as-is
 * rather than silently rewritten, so validate.ts's enum checks (editMode,
 * vendor, authType, searchScope) can actually catch it. Silently coercing an
 * operator-declared value to a different one here would both hide a mistake
 * and mean deploy sends something other than what was declared.
 */
function readWithDefault(value: unknown, fallback: string): string {
  const v = readString(value)
  return v || fallback
}

export function readProviderType(value: unknown): FederationProviderId {
  return readString(value) === 'kerberos' ? 'kerberos' : 'ldap'
}

/** The fields this config type declares, read from the raw canvas record with defaults applied. */
export interface FederationFields {
  providerType: FederationProviderId
  name: string
  enabled: boolean
  priority: number
  editMode: string
  importEnabled: boolean
  syncRegistrations: boolean
  vendor: string
  usernameLdapAttribute: string
  rdnLdapAttribute: string
  uuidLdapAttribute: string
  userObjectClasses: string[]
  connectionUrl: string
  usersDn: string
  authType: string
  bindDn: string
  /** Write-only. */
  bindCredential: string
  searchScope: string
  customUserSearchFilter: string
  connectionTimeout?: number
  readTimeout?: number
  pagination: boolean
  startTls: boolean
  connectionPooling: boolean
  batchSizeForSync: number
  fullSyncPeriod?: number
  changedSyncPeriod?: number
  validatePasswordPolicy: boolean
  trustEmail: boolean
  usePasswordModifyExtendedOp: boolean
  allowKerberosAuthentication: boolean
  kerberosRealm: string
  serverPrincipal: string
  /** Write-only. */
  keyTab: string
  useKerberosForPasswordAuthentication: boolean
  debug: boolean
}

export function readFederationFields(fields: Record<string, unknown>): FederationFields {
  return {
    providerType: readProviderType(fields.providerType),
    name: readString(fields.name),
    enabled: readBool(fields.enabled, true),
    priority: readNumber(fields.priority, 0),
    editMode: readWithDefault(fields.editMode, 'READ_ONLY'),
    importEnabled: readBool(fields.importEnabled, true),
    syncRegistrations: readBool(fields.syncRegistrations, false),
    vendor: readWithDefault(fields.vendor, 'other'),
    usernameLdapAttribute: readString(fields.usernameLdapAttribute),
    rdnLdapAttribute: readString(fields.rdnLdapAttribute),
    uuidLdapAttribute: readString(fields.uuidLdapAttribute),
    userObjectClasses: readStringArray(fields.userObjectClasses),
    connectionUrl: readString(fields.connectionUrl),
    usersDn: readString(fields.usersDn),
    authType: readWithDefault(fields.authType, 'simple'),
    bindDn: readString(fields.bindDn),
    bindCredential: readString(fields.bindCredential),
    searchScope: readWithDefault(fields.searchScope, '2'),
    customUserSearchFilter: readString(fields.customUserSearchFilter),
    connectionTimeout: readOptionalNumber(fields.connectionTimeout),
    readTimeout: readOptionalNumber(fields.readTimeout),
    pagination: readBool(fields.pagination, true),
    startTls: readBool(fields.startTls, false),
    connectionPooling: readBool(fields.connectionPooling, false),
    batchSizeForSync: readNumber(fields.batchSizeForSync, 1000),
    fullSyncPeriod: readOptionalNumber(fields.fullSyncPeriod),
    changedSyncPeriod: readOptionalNumber(fields.changedSyncPeriod),
    validatePasswordPolicy: readBool(fields.validatePasswordPolicy, false),
    trustEmail: readBool(fields.trustEmail, false),
    usePasswordModifyExtendedOp: readBool(fields.usePasswordModifyExtendedOp, false),
    allowKerberosAuthentication: readBool(fields.allowKerberosAuthentication, false),
    kerberosRealm: readString(fields.kerberosRealm),
    serverPrincipal: readString(fields.serverPrincipal),
    keyTab: readString(fields.keyTab),
    useKerberosForPasswordAuthentication: readBool(fields.useKerberosForPasswordAuthentication, false),
    debug: readBool(fields.debug, false),
  }
}

// --- Field <-> config projection -----------------------------------------
//
// VERIFIED against Keycloak's LDAPConstants.java source: the wire config keys
// are the all-caps-LDAP form USERNAME_LDAP_ATTRIBUTE="usernameLDAPAttribute",
// RDN_LDAP_ATTRIBUTE="rdnLDAPAttribute", UUID_LDAP_ATTRIBUTE="uuidLDAPAttribute"
// — NOT the "usernameLdapAttribute" casing this app's own canvas field KEYS use
// (those are just this app's internal field names; buildLdapFlatConfig below is
// the one place that translates from our field-key casing to Keycloak's actual
// wire-key casing, so get this translation right and every other file can stay
// in the more readable camelCase).

/** Every config key this config type manages for an LDAP provider, in build order. */
const LDAP_CONFIG_KEYS = [
  'enabled',
  'priority',
  'editMode',
  'importEnabled',
  'syncRegistrations',
  'vendor',
  'usernameLDAPAttribute',
  'rdnLDAPAttribute',
  'uuidLDAPAttribute',
  'userObjectClasses',
  'connectionUrl',
  'usersDn',
  'authType',
  'bindDn',
  'bindCredential',
  'searchScope',
  'customUserSearchFilter',
  'connectionTimeout',
  'readTimeout',
  'pagination',
  'startTls',
  'connectionPooling',
  'batchSizeForSync',
  'fullSyncPeriod',
  'changedSyncPeriod',
  'validatePasswordPolicy',
  'trustEmail',
  'usePasswordModifyExtendedOp',
  'allowKerberosAuthentication',
  'kerberosRealm',
  'serverPrincipal',
  'keyTab',
  'useKerberosForPasswordAuthentication',
  'debug',
] as const

/** Every config key this config type manages for a standalone Kerberos provider. */
const KERBEROS_CONFIG_KEYS = [
  'enabled',
  'priority',
  'editMode',
  'kerberosRealm',
  'serverPrincipal',
  'keyTab',
  'useKerberosForPasswordAuthentication',
  'debug',
] as const

function boolStr(value: boolean): string {
  return value ? 'true' : 'false'
}

/** Build the flat (pre-wrap) config for an LDAP provider. Optional/secret keys are OMITTED when blank so an update never clobbers an existing value with an empty one. */
function buildLdapFlatConfig(f: FederationFields): Record<string, string> {
  const cfg: Record<string, string> = {
    enabled: boolStr(f.enabled),
    priority: String(f.priority),
    editMode: f.editMode,
    importEnabled: boolStr(f.importEnabled),
    syncRegistrations: boolStr(f.syncRegistrations),
    vendor: f.vendor,
    usernameLDAPAttribute: f.usernameLdapAttribute,
    rdnLDAPAttribute: f.rdnLdapAttribute,
    uuidLDAPAttribute: f.uuidLdapAttribute,
    userObjectClasses: joinUserObjectClasses(f.userObjectClasses),
    connectionUrl: f.connectionUrl,
    usersDn: f.usersDn,
    authType: f.authType,
    searchScope: f.searchScope,
    pagination: boolStr(f.pagination),
    startTls: boolStr(f.startTls),
    connectionPooling: boolStr(f.connectionPooling),
    batchSizeForSync: String(f.batchSizeForSync),
    validatePasswordPolicy: boolStr(f.validatePasswordPolicy),
    trustEmail: boolStr(f.trustEmail),
    usePasswordModifyExtendedOp: boolStr(f.usePasswordModifyExtendedOp),
    // Kerberos integration is opt-in for an LDAP provider.
    allowKerberosAuthentication: boolStr(f.allowKerberosAuthentication),
    useKerberosForPasswordAuthentication: boolStr(f.useKerberosForPasswordAuthentication),
    debug: boolStr(f.debug),
  }
  if (f.bindDn) cfg.bindDn = f.bindDn
  if (f.bindCredential) cfg.bindCredential = f.bindCredential // write-only
  if (f.customUserSearchFilter) cfg.customUserSearchFilter = f.customUserSearchFilter
  if (f.connectionTimeout !== undefined) cfg.connectionTimeout = String(f.connectionTimeout)
  if (f.readTimeout !== undefined) cfg.readTimeout = String(f.readTimeout)
  if (f.fullSyncPeriod !== undefined) cfg.fullSyncPeriod = String(f.fullSyncPeriod)
  if (f.changedSyncPeriod !== undefined) cfg.changedSyncPeriod = String(f.changedSyncPeriod)
  if (f.kerberosRealm) cfg.kerberosRealm = f.kerberosRealm
  if (f.serverPrincipal) cfg.serverPrincipal = f.serverPrincipal
  if (f.keyTab) cfg.keyTab = f.keyTab // write-only
  return cfg
}

/** Build the flat (pre-wrap) config for a standalone Kerberos provider — no LDAP connection fields. */
function buildKerberosFlatConfig(f: FederationFields): Record<string, string> {
  const cfg: Record<string, string> = {
    enabled: boolStr(f.enabled),
    priority: String(f.priority),
    editMode: f.editMode,
    useKerberosForPasswordAuthentication: boolStr(f.useKerberosForPasswordAuthentication),
    debug: boolStr(f.debug),
  }
  if (f.kerberosRealm) cfg.kerberosRealm = f.kerberosRealm
  if (f.serverPrincipal) cfg.serverPrincipal = f.serverPrincipal
  if (f.keyTab) cfg.keyTab = f.keyTab // write-only
  return cfg
}

/** The single source of truth for "what config this config type authors" — shared by the builder and the drift projector. */
function flatConfigFor(f: FederationFields): Record<string, string> {
  return f.providerType === 'kerberos' ? buildKerberosFlatConfig(f) : buildLdapFlatConfig(f)
}

function pickManagedKeys(flat: Record<string, string>, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of keys) {
    if (key in flat) out[key] = flat[key]
  }
  return out
}

/** Build the config Map<String, List<String>> for the item's providerType branch. */
export function buildComponentConfig(f: FederationFields): Record<string, string[]> {
  return toComponentConfig(flatConfigFor(f))
}

/**
 * Build the ComponentRepresentation body from canvas fields. `base` (the
 * existing live component, when updating) is spread first so Keycloak-managed
 * fields we do not author (id, parentId, …) survive an update; its config is
 * merged UNDER the freshly-built config so every authored field wins, after
 * first stripping any secret keys out of `base` (see stripSecretsFromComponent
 * — a live GET only ever returns those masked, never the real value, so they
 * must never be allowed to survive into a merged config as if they were real).
 * `parentId` is NOT set here — deploy.ts assigns it from the realm's resolved
 * internal id, since it is not a canvas field.
 */
export function buildComponentRep(fields: Record<string, unknown>, base?: KeycloakComponentRep): KeycloakComponentRep {
  const f = readFederationFields(fields)
  const baseConfig = base ? (stripSecretsFromComponent(base).config ?? {}) : {}
  return {
    ...(base ?? {}),
    name: f.name,
    providerId: f.providerType,
    providerType: USER_STORAGE_PROVIDER_TYPE,
    config: { ...baseConfig, ...buildComponentConfig(f) },
  }
}

/** The fields this config type declares, projected for drift comparison. */
export interface FederationProjection {
  providerId: string
  enabled: boolean
  priority: number
  /** Non-secret config keys THIS APP MANAGES only — Keycloak-internal extras (lastSync, cachePolicy, …) are intentionally excluded to avoid false-positive drift. */
  config: Record<string, string>
}

export function projectFromFields(fields: Record<string, unknown>): FederationProjection {
  const f = readFederationFields(fields)
  return {
    providerId: f.providerType,
    enabled: f.enabled,
    priority: f.priority,
    config: nonSecretConfig(flatConfigFor(f)),
  }
}

export function projectFromLive(component: KeycloakComponentRep): FederationProjection {
  const providerId = readString(component.providerId)
  const flat = fromComponentConfig(component.config)
  const managedKeys = providerId === 'kerberos' ? KERBEROS_CONFIG_KEYS : LDAP_CONFIG_KEYS
  return {
    providerId,
    enabled: readBool(flat.enabled, false),
    priority: readNumber(flat.priority, 0),
    config: nonSecretConfig(pickManagedKeys(flat, managedKeys)),
  }
}
