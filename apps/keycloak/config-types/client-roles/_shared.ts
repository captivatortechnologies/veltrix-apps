// Shared helpers for the Keycloak Client Roles config type (deploy + rollback +
// drift).
//
// Client roles follow the same Keycloak Admin REST API RoleRepresentation as
// realm roles (see config-types/realm-roles/_shared.ts), but scoped under a
// resolved client: /admin/realms/{realm}/clients/{clientUuid}/roles. The role
// NAME is the {role-name} path segment for GET/PUT/DELETE
// .../roles/{role-name}, exactly as for realm roles — the difference is that
// role names are only unique WITHIN a client, so two different clients may each
// have a role named e.g. "admin". This config type's canvas identityField is
// still just "name" (matching the app's per-item single-field identity
// convention), but validate.ts's duplicate check keys on the composite
// (clientId, name) pair — see validate.ts.
//
// Verified against the official Keycloak Admin REST API
// (www.keycloak.org/docs-api/latest/rest-api — "Roles" resource, "Clients" role
// sub-resource: GET/POST/PUT/DELETE .../clients/{id}/roles[/{role-name}]).

import { readBool, readOptionalString, readString } from '../../lib/fields'

/** A Keycloak client role as returned by GET .../clients/{clientUuid}/roles/{role-name}. */
export interface KeycloakClientRoleRep {
  /** Internal UUID — not used for routing (client roles are addressed by name). */
  id?: string
  /** The role name — this config type's identity AND the {role-name} path segment. */
  name?: string
  description?: string
  /** True when the role is a composite (aggregates other roles). */
  composite?: boolean
  /** The owning client's internal UUID. */
  containerId?: string
  /** True for a client role (always true here, set by Keycloak). */
  clientRole?: boolean
  [key: string]: unknown
}

/**
 * Build the RoleRepresentation body from canvas fields. `base` (the existing live
 * role, when updating) is spread first so Keycloak-managed fields we do not
 * author (id, containerId, attributes, …) survive an update instead of being
 * wiped.
 */
export function buildClientRoleRep(
  fields: Record<string, unknown>,
  base?: KeycloakClientRoleRep,
): KeycloakClientRoleRep {
  const rep: KeycloakClientRoleRep = {
    ...(base ?? {}),
    name: readString(fields.name),
    composite: readBool(fields.composite, false),
  }
  const description = readOptionalString(fields.description)
  if (description !== undefined) rep.description = description
  else if (base && 'description' in base) rep.description = base.description
  return rep
}

/** The fields this config type declares, projected for drift comparison. */
export interface ClientRoleProjection {
  description: string
  composite: boolean
}

export function projectFromFields(fields: Record<string, unknown>): ClientRoleProjection {
  return {
    description: readString(fields.description),
    composite: readBool(fields.composite, false),
  }
}

export function projectFromLive(role: KeycloakClientRoleRep): ClientRoleProjection {
  return {
    description: readString(role.description),
    composite: readBool(role.composite, false),
  }
}
