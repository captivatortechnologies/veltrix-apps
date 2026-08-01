// Shared helpers for the Keycloak Identity Providers config type (deploy + rollback + drift).
//
// Identity providers follow the Keycloak Admin REST API IdentityProviderRepresentation
// (/admin/realms/{realm}/identity-provider/instances). The `alias` is both the human
// identity and the {alias} path segment for GET/PUT/DELETE .../instances/{alias}, so
// `alias` is this config type's stable identity.
//
// `config` is a provider-specific Map<String,String> (endpoints, clientId, secrets,
// …). The exact keys depend on providerId (e.g. oidc: authorizationUrl/tokenUrl/
// clientId/clientSecret; saml: singleSignOnServiceUrl/entityId; google: clientId/
// clientSecret), so it is authored as a free key/value map rather than fixed fields.
//
// Verified against the official Keycloak Admin REST API
// (www.keycloak.org/docs-api/latest/rest-api — "Identity Providers" resource).

import { readBool, readKeyValueMap, readOptionalString, readString } from '../../lib/fields'

/** Curated built-in providerId values Keycloak ships. Additional providers exist. */
export const PROVIDER_IDS = new Set([
  'oidc',
  'keycloak-oidc',
  'saml',
  'google',
  'github',
  'gitlab',
  'microsoft',
  'facebook',
  'linkedin-openid-connect',
  'bitbucket',
  'paypal',
  'stackoverflow',
  'openshift-v4',
])

/** An identity provider instance as returned by GET .../identity-provider/instances/{alias}. */
export interface KeycloakIdpRep {
  /** The provider alias — this config type's identity AND the {alias} path segment. */
  alias?: string
  displayName?: string
  /** The provider type (oidc, saml, google, …). */
  providerId?: string
  enabled?: boolean
  /** Provider-specific config: endpoints, clientId, clientSecret, … */
  config?: Record<string, string>
  [key: string]: unknown
}

/** A config key holds secret material (write-only; excluded from drift comparison). */
export function isSecretConfigKey(key: string): boolean {
  return /secret/i.test(key)
}

/** Drop secret-bearing keys from a config map (Keycloak returns them masked). */
export function nonSecretConfig(config: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(config)) {
    if (!isSecretConfigKey(key)) out[key] = value
  }
  return out
}

/**
 * Build the IdentityProviderRepresentation body from canvas fields. `base` (the
 * existing live provider, when updating) is spread first so Keycloak-managed fields
 * we do not author (internalId, mappers, link settings, …) survive an update.
 */
export function buildIdpRep(fields: Record<string, unknown>, base?: KeycloakIdpRep): KeycloakIdpRep {
  const rep: KeycloakIdpRep = {
    ...(base ?? {}),
    alias: readString(fields.alias),
    providerId: readString(fields.providerId),
    enabled: readBool(fields.enabled, true),
    config: { ...(base?.config ?? {}), ...readKeyValueMap(fields.config) },
  }
  const displayName = readOptionalString(fields.displayName)
  if (displayName !== undefined) rep.displayName = displayName
  else if (base && 'displayName' in base) rep.displayName = base.displayName
  return rep
}

/** The fields this config type declares, projected for drift (secrets excluded). */
export interface IdpProjection {
  displayName: string
  providerId: string
  enabled: boolean
  config: Record<string, string>
}

export function projectFromFields(fields: Record<string, unknown>): IdpProjection {
  return {
    displayName: readString(fields.displayName),
    providerId: readString(fields.providerId),
    enabled: readBool(fields.enabled, true),
    config: nonSecretConfig(readKeyValueMap(fields.config)),
  }
}

export function projectFromLive(idp: KeycloakIdpRep): IdpProjection {
  return {
    displayName: readString(idp.displayName),
    providerId: readString(idp.providerId),
    enabled: readBool(idp.enabled, false),
    config: nonSecretConfig(idp.config ?? {}),
  }
}
