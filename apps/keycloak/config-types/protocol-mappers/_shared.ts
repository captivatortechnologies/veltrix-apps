// Shared helpers for the Keycloak Protocol Mappers config type (deploy +
// rollback + drift).
//
// A protocol mapper attaches to EITHER an existing client OR an existing client
// scope — two structurally identical sub-resources of the Admin REST API
// ProtocolMapperRepresentation:
//   client:        /admin/realms/{realm}/clients/{clientUuid}/protocol-mappers/models
//   client scope:  /admin/realms/{realm}/client-scopes/{scopeUuid}/protocol-mappers/models
//
// This config type's identity is the COMPOSITE (targetType, targetRef, name):
// the same mapper name may legitimately exist on a client AND a client scope,
// or on two different clients, so name alone is not unique.
//
// `protocolMapper` (the mapper type id, e.g. oidc-usermodel-attribute-mapper) is
// authored as free text rather than a fixed enum — Keycloak ships dozens of
// built-ins and third-party providers can add more. Verified against the
// official `keycloak_generic_protocol_mapper` Terraform resource, which takes
// the same free-text protocol_mapper + config map shape
// (registry.terraform.io/providers/keycloak/keycloak/latest/docs/resources/generic_protocol_mapper).
//
// Verified against the official Keycloak Admin REST API
// (www.keycloak.org/docs-api/latest/rest-api — "Protocol Mappers" resource).

import { readKeyValueMap, readString } from '../../lib/fields'
import { parseJson } from '../../lib/keycloakApi'
import type { KeycloakAdminClient } from '../../lib/keycloakApi'

export const TARGET_TYPES = new Set(['client', 'client-scope'])
export type ProtocolMapperTargetType = 'client' | 'client-scope'

/** A protocol mapper as returned by GET {base}/protocol-mappers/models. */
export interface KeycloakProtocolMapperRep {
  /** Internal UUID — the {id} path segment for GET/PUT/DELETE .../models/{id}. */
  id?: string
  /** The mapper's display name — part of this config type's composite identity. */
  name?: string
  protocol?: string
  protocolMapper?: string
  config?: Record<string, string>
  [key: string]: unknown
}

/** A client scope reference as returned by GET /client-scopes. */
export interface KeycloakClientScopeRef {
  id?: string
  name?: string
  [key: string]: unknown
}

/**
 * Resolve a client scope by its human name. The Keycloak Admin REST API has no
 * server-side name filter on the client-scopes list endpoint, so this fetches
 * the full list and matches client-side. Best-effort — returns null on a miss.
 * A LOCAL helper (not lib/clients.ts) because config types never import from a
 * sibling config-type folder, and no other config type currently needs this.
 */
export async function resolveClientScopeByName(
  admin: KeycloakAdminClient,
  name: string,
): Promise<KeycloakClientScopeRef | null> {
  const target = name.trim()
  if (!target) return null
  const res = await admin.get('/client-scopes')
  if (!res.ok) return null
  const list = parseJson<KeycloakClientScopeRef[]>(res.body) ?? []
  return list.find((s) => String(s.name ?? '').trim() === target) ?? null
}

/** The protocol-mappers/models base path under a resolved parent (client or client scope) UUID. */
export function mapperBasePath(targetType: ProtocolMapperTargetType, parentId: string): string {
  const parentSegment = targetType === 'client' ? 'clients' : 'client-scopes'
  return `/${parentSegment}/${encodeURIComponent(parentId)}/protocol-mappers/models`
}

/** Find a mapper by its name (the identity within one target's mapper list). */
export function findMapperByName(mappers: KeycloakProtocolMapperRep[], name: string): KeycloakProtocolMapperRep | null {
  const target = name.trim()
  if (!target) return null
  return mappers.find((m) => String(m.name ?? '').trim() === target) ?? null
}

/**
 * Build the ProtocolMapperRepresentation body from canvas fields. `config` is
 * authored as the full authoritative map (mirrors the generic Terraform
 * resource this is modeled on) — a key removed from the canvas is removed from
 * the mapper on the next deploy, unlike identity-providers' config which merges
 * forward to preserve masked secrets.
 */
export function buildMapperRep(
  fields: Record<string, unknown>,
  base?: KeycloakProtocolMapperRep,
): KeycloakProtocolMapperRep {
  return {
    ...(base ?? {}),
    name: readString(fields.name),
    protocol: readString(fields.protocol) || 'openid-connect',
    protocolMapper: readString(fields.protocolMapper),
    config: readKeyValueMap(fields.config),
  }
}

/** The fields this config type declares, projected for drift comparison. */
export interface MapperProjection {
  protocolMapper: string
  config: Record<string, string>
}

export function projectFromFields(fields: Record<string, unknown>): MapperProjection {
  return {
    protocolMapper: readString(fields.protocolMapper),
    config: readKeyValueMap(fields.config),
  }
}

export function projectFromLive(mapper: KeycloakProtocolMapperRep): MapperProjection {
  return {
    protocolMapper: readString(mapper.protocolMapper),
    config: mapper.config ?? {},
  }
}
