// Shared helpers for the Greenbone Roles config type (deploy + rollback +
// drift). A role is a named capability set a user/group can hold; permissions
// attach to it only via the separate Permissions config type (create_role has
// no permission list of its own — see lib/gmp/roles.ts). Applied over GMP
// (XML over TLS). The role NAME is the stable identity used to upsert — gvmd
// does not enforce unique names, so this app treats the name as the key.
//
// FLAG: the 7 predefined/protected roles (see lib/gmp/roles.ts's
// PREDEFINED_ROLES) are never created/modified/deleted by this app.

import type { RoleInput, GmpRole } from '../../lib/gmp/roles'
import { PREDEFINED_ROLE_NAMES, PREDEFINED_ROLE_IDS } from '../../lib/gmp/roles'

export { PREDEFINED_ROLE_NAMES, PREDEFINED_ROLE_IDS }

export function buildRoleInput(fields: Record<string, unknown>): RoleInput {
  const users = Array.isArray(fields.users)
    ? fields.users.map((v) => String(v).trim()).filter(Boolean)
    : String(fields.users ?? '')
        .split(/[\s,]+/)
        .map((v) => v.trim())
        .filter(Boolean)
  return {
    name: String(fields.name ?? '').trim(),
    comment: String(fields.comment ?? '').trim(),
    users,
  }
}

/** Find a live, NON-predefined role by name (trimmed, case-sensitive). Predefined roles are excluded so this app never targets them. */
export function findRoleByName(roles: GmpRole[], name: string): GmpRole | null {
  const n = name.trim()
  if (!n) return null
  return roles.find((r) => r.name.trim() === n && !PREDEFINED_ROLE_IDS.has(r.id)) ?? null
}
