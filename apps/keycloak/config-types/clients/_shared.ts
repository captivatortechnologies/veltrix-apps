// Shared helpers for the Keycloak Clients config type (deploy + rollback + drift).
//
// Client shapes follow the Keycloak Admin REST API ClientRepresentation
// (/admin/realms/{realm}/clients). The `id` is the internal UUID (path id), while
// `clientId` is the human identifier and this config type's stable identity.
// Verify the exact ClientRepresentation surface against a live Keycloak.

/** Valid Keycloak client protocols. */
export const PROTOCOLS = new Set(['openid-connect', 'saml'])

/** A Keycloak client as returned by GET /admin/realms/{realm}/clients. */
export interface KeycloakClientRep {
  /** Internal UUID — the {id} path segment for GET/PUT/DELETE .../clients/{id}. */
  id?: string
  /** The human client identifier — this config type's identity. */
  clientId?: string
  name?: string
  protocol?: string
  enabled?: boolean
  publicClient?: boolean
  standardFlowEnabled?: boolean
  redirectUris?: string[]
  [key: string]: unknown
}

/**
 * Coerce a canvas checkbox / API value to a boolean. Canvas sends real booleans;
 * be tolerant of 'true'/'false'/1/0 strings from either side.
 */
export function normalizeBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (value == null) return fallback
  const s = String(value).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false
  return fallback
}

/** Parse a redirect-URIs textarea (newline- or comma-separated) into a clean array. */
export function parseRedirectUris(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  return String(value ?? '')
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Two redirect-URI lists are equal when they hold the same set (order-insensitive). */
export function redirectUrisEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setB = new Set(b)
  return a.every((uri) => setB.has(uri))
}

/** Find a live client by its clientId (the stable identity). */
export function findClientByClientId(clients: KeycloakClientRep[], clientId: string): KeycloakClientRep | null {
  const target = clientId.trim()
  if (!target) return null
  return clients.find((c) => String(c.clientId ?? '').trim() === target) ?? null
}

/**
 * Build the ClientRepresentation body from canvas fields. `base` (the existing
 * live client, when updating) is spread first so Keycloak-managed fields we do
 * not author (protocolMappers, attributes, etc.) survive an update instead of
 * being wiped.
 */
export function buildClientRep(fields: Record<string, unknown>, base?: KeycloakClientRep): KeycloakClientRep {
  const redirectUris = parseRedirectUris(fields.redirectUris)
  const rep: KeycloakClientRep = {
    ...(base ?? {}),
    clientId: String(fields.clientId ?? '').trim(),
    protocol: String(fields.protocol ?? 'openid-connect').trim(),
    enabled: normalizeBool(fields.enabled, true),
    publicClient: normalizeBool(fields.publicClient, false),
    standardFlowEnabled: normalizeBool(fields.standardFlowEnabled, true),
    redirectUris,
  }
  const name = String(fields.name ?? '').trim()
  if (name) rep.name = name
  else if (base && 'name' in base) rep.name = base.name
  return rep
}

/** The fields this config type declares, projected off a live client for drift. */
export interface ClientProjection {
  name: string
  protocol: string
  enabled: boolean
  publicClient: boolean
  standardFlowEnabled: boolean
  redirectUris: string[]
}

export function projectFromFields(fields: Record<string, unknown>): ClientProjection {
  return {
    name: String(fields.name ?? '').trim(),
    protocol: String(fields.protocol ?? 'openid-connect').trim(),
    enabled: normalizeBool(fields.enabled, true),
    publicClient: normalizeBool(fields.publicClient, false),
    standardFlowEnabled: normalizeBool(fields.standardFlowEnabled, true),
    redirectUris: parseRedirectUris(fields.redirectUris),
  }
}

export function projectFromLive(client: KeycloakClientRep): ClientProjection {
  return {
    name: String(client.name ?? '').trim(),
    protocol: String(client.protocol ?? '').trim(),
    enabled: normalizeBool(client.enabled, false),
    publicClient: normalizeBool(client.publicClient, false),
    standardFlowEnabled: normalizeBool(client.standardFlowEnabled, false),
    redirectUris: Array.isArray(client.redirectUris) ? client.redirectUris.map(String) : [],
  }
}
