// Shared helpers for the Keycloak Realm Roles config type (deploy + rollback + drift).
//
// Realm roles follow the Keycloak Admin REST API RoleRepresentation
// (/admin/realms/{realm}/roles). The role NAME is both the human identity and the
// {role-name} path segment for GET/PUT/DELETE .../roles/{role-name}, so `name` is
// this config type's stable identity.
//
// Verified against the official Keycloak Admin REST API
// (www.keycloak.org/docs-api/latest/rest-api — "Roles" resource).

import { readBool, readOptionalString, readString } from '../../lib/fields'

/** A Keycloak realm role as returned by GET /admin/realms/{realm}/roles/{role-name}. */
export interface KeycloakRoleRep {
  /** Internal UUID — not used for routing (roles are addressed by name). */
  id?: string
  /** The role name — this config type's identity AND the {role-name} path segment. */
  name?: string
  description?: string
  /** True when the role is a composite (aggregates other roles). */
  composite?: boolean
  containerId?: string
  [key: string]: unknown
}

/**
 * Build the RoleRepresentation body from canvas fields. `base` (the existing live
 * role, when updating) is spread first so Keycloak-managed fields we do not author
 * (id, containerId, attributes, …) survive an update instead of being wiped.
 */
export function buildRoleRep(fields: Record<string, unknown>, base?: KeycloakRoleRep): KeycloakRoleRep {
  const rep: KeycloakRoleRep = {
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
export interface RoleProjection {
  description: string
  composite: boolean
}

export function projectFromFields(fields: Record<string, unknown>): RoleProjection {
  return {
    description: readString(fields.description),
    composite: readBool(fields.composite, false),
  }
}

export function projectFromLive(role: KeycloakRoleRep): RoleProjection {
  return {
    description: readString(role.description),
    composite: readBool(role.composite, false),
  }
}
