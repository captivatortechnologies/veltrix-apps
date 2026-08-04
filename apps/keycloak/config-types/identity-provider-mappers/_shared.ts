// Shared helpers for the Keycloak Identity Provider Mappers config type (deploy
// + rollback + drift).
//
// A mapper attaches to an EXISTING identity provider instance (this config type
// does not create IdPs — see the identity-providers config type):
//   GET/POST        /admin/realms/{realm}/identity-provider/instances/{alias}/mappers
//   GET/PUT/DELETE  .../mappers/{id}
//
// IdentityProviderMapperRepresentation has exactly 5 fields — id, name,
// identityProviderAlias, identityProviderMapper, config (defaults to {}) —
// verified directly against Keycloak's IdentityProviderMapperRepresentation.java
// source. This config type's identity is the COMPOSITE (alias, name): the same
// mapper name may legitimately exist on two different identity providers.
//
// `identityProviderMapper` (the mapper type id) is authored as free text — see
// the keycloak_custom_identity_provider_mapper /
// keycloak_attribute_importer_identity_provider_mapper /
// keycloak_hardcoded_role_identity_provider_mapper Terraform resources
// (registry.terraform.io/providers/keycloak/keycloak/latest/docs/resources/)
// for the built-in type ids this is modeled on.
//
// Verified against the official Keycloak Admin REST API
// (www.keycloak.org/docs-api/latest/rest-api — "Identity Providers" resource,
// the .../mappers sub-resource).

import { readKeyValueMap, readString } from '../../lib/fields'

/** An identity-provider mapper as returned by GET .../instances/{alias}/mappers. */
export interface KeycloakIdpMapperRep {
  /** Internal UUID — the {id} path segment for GET/PUT/DELETE .../mappers/{id}. */
  id?: string
  /** The mapper's display name — part of this config type's composite identity. */
  name?: string
  identityProviderAlias?: string
  identityProviderMapper?: string
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

/** Find a mapper by its name (the identity within one identity provider's mapper list). */
export function findMapperByName(mappers: KeycloakIdpMapperRep[], name: string): KeycloakIdpMapperRep | null {
  const target = name.trim()
  if (!target) return null
  return mappers.find((m) => String(m.name ?? '').trim() === target) ?? null
}

/**
 * Build the IdentityProviderMapperRepresentation body from canvas fields.
 * `config` is authored as the full authoritative map — a key removed from the
 * canvas is removed from the mapper on the next deploy.
 */
export function buildMapperRep(
  fields: Record<string, unknown>,
  alias: string,
  base?: KeycloakIdpMapperRep,
): KeycloakIdpMapperRep {
  return {
    ...(base ?? {}),
    name: readString(fields.name),
    identityProviderAlias: alias,
    identityProviderMapper: readString(fields.identityProviderMapper),
    config: readKeyValueMap(fields.config),
  }
}

/** The fields this config type declares, projected for drift (secrets excluded). */
export interface MapperProjection {
  identityProviderMapper: string
  config: Record<string, string>
}

export function projectFromFields(fields: Record<string, unknown>): MapperProjection {
  return {
    identityProviderMapper: readString(fields.identityProviderMapper),
    config: nonSecretConfig(readKeyValueMap(fields.config)),
  }
}

export function projectFromLive(mapper: KeycloakIdpMapperRep): MapperProjection {
  return {
    identityProviderMapper: readString(mapper.identityProviderMapper),
    config: nonSecretConfig(mapper.config ?? {}),
  }
}
