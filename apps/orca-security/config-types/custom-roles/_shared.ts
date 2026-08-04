// Shared helpers for the Orca Custom Roles config type (deploy + rollback +
// drift).
//
// Orca custom RBAC roles follow the /api/rbac/roles surface (VERIFIED against
// terraform-provider-orcasecurity api_client/custom_role.go):
//   POST   /api/rbac/roles          create; returns { data: { id, name, description, permission_groups } }
//   GET    /api/rbac/roles/{id}      read;   returns { data: { ... } }
//   PUT    /api/rbac/roles/{id}      update
//   DELETE /api/rbac/roles/{id}      delete
//
// A role is a named set of permission groups (e.g. "assets.asset.read") a user
// or group can be assigned. This app manages role DEFINITIONS only — not
// ASSIGNING a role to a user/group (a separate, identity-bootstrap surface
// backed by /api/rbac/access/{group,user} — see README Coverage for why that
// is out of scope here).
//
// Permission-group strings are Orca-internal and not enumerated by a public
// catalog endpoint this app can call safely — copy them from an existing role
// in the Orca UI (Settings > Roles), the same "FLAG" pattern this app already
// uses for automation action type codes.

import type { ReconcileData, ReconcileEntry } from '../../lib/reconcile'

/** One Orca custom role (the `data` payload of /api/rbac/roles responses). */
export interface OrcaCustomRole {
  id?: string
  name?: string
  description?: string
  permission_groups?: string[]
  [key: string]: unknown
}

export type CustomRoleRollbackEntry = ReconcileEntry<OrcaCustomRole>
export type CustomRoleRollbackData = ReconcileData<OrcaCustomRole>

/** Build the Orca custom-role body from canvas fields (POST/PUT payload). */
export function buildCustomRoleBody(fields: Record<string, unknown>, serverId?: string | null): OrcaCustomRole {
  const body: OrcaCustomRole = {
    name: String(fields.name ?? '').trim(),
    description: String(fields.description ?? '').trim(),
    permission_groups: Array.isArray(fields.permissionGroups)
      ? fields.permissionGroups.map((v) => String(v).trim()).filter(Boolean)
      : String(fields.permissionGroups ?? '')
          .split(/[\n,]/)
          .map((v) => v.trim())
          .filter(Boolean),
  }
  // The official provider's PUT sends the id inline on the body (matching its
  // Go struct); harmless for POST since there is no id yet.
  if (serverId) body.id = serverId
  return body
}

/** Unwrap a `{ data: {...} }` envelope, returning null when absent. */
export function customRoleFromEnvelope(payload: unknown): OrcaCustomRole | null {
  if (!payload || typeof payload !== 'object') return null
  const data = (payload as { data?: OrcaCustomRole }).data
  return data && typeof data === 'object' ? data : null
}
