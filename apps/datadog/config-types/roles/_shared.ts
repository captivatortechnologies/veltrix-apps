// =============================================================================
// Shared types + helpers for the Datadog Roles (RBAC) config type.
//
// Verified against the official Datadog API docs (a JSON:API resource):
//   List roles:    GET    /api/v2/roles
//   Get a role:    GET    /api/v2/roles/{role_id}
//   Create a role: POST   /api/v2/roles
//                  body: { "data": { "type": "roles", "attributes": { name },
//                  "relationships": { "permissions": { "data": [{ "id",
//                  "type": "permissions" }] } } } } — permissions CAN be
//                  attached at creation via the relationship.
//   Update a role: PATCH  /api/v2/roles/{role_id}   (renames; body: { "data":
//                  { "type": "roles", "id", "attributes": { name } } })
//   Delete a role: DELETE /api/v2/roles/{role_id}
//   List permissions:        GET    /api/v2/permissions
//   List a role's grants:    GET    /api/v2/roles/{role_id}/permissions
//   Grant a permission:      POST   /api/v2/roles/{role_id}/permissions
//                            body: { "data": { "id": "<permission_id>",
//                            "type": "permissions" } }
//   Revoke a permission:     DELETE /api/v2/roles/{role_id}/permissions
//                            (same body shape as grant, as a DELETE body)
//
// This app authors permissions by NAME (e.g. "monitors_write") on the
// canvas — friendlier than Datadog's opaque permission UUIDs — and resolves
// names to ids via GET /api/v2/permissions at deploy time (network access,
// so this happens in permissions.ts, not here). For UNIFORMITY, this app
// creates a role bare (name only) and then GRANTS its declared permissions
// through the SAME path used for updates, rather than embedding permissions
// in the create call — one code path for both create and update.
//
// ADDITIVE-ONLY, NOT A FULL SYNC: this app grants every declared permission
// but never revokes an undeclared one. Datadog's create-role reference
// documents that several read permissions (Dashboards/Notebooks/Monitors/
// APM/Vulnerability Management/RUM Apps/Incidents/SLOs/CI Visibility/CD
// Visibility, all "Read") are automatically added to EVERY new role — a full
// grant/revoke sync would fight that baseline set on every deploy. See
// permissions.ts for the full rationale.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

export const MAX_NAME_LENGTH = 255

export interface RoleAttributes {
  name?: string
  [key: string]: unknown
}

export interface RoleResource {
  id?: string
  type?: string
  attributes?: RoleAttributes
}

/** A resolved Datadog permission (id + the canonical name it's granted/revoked by). */
export interface PermissionRef {
  id: string
  name: string
  aliases: string[]
}

export interface RoleBody {
  name: string
}

export interface RoleSpec {
  name: string
  permissionNames: string[]
}

export function readStringArray(value: unknown): string[] {
  const raw: string[] = Array.isArray(value)
    ? value.map((v) => (typeof v === 'string' ? v : String(v ?? '')))
    : typeof value === 'string'
      ? value.split(/[\n,]+/)
      : []
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

export function extractRoleSpec(fields: Record<string, unknown>): RoleSpec {
  const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  return {
    name: str(fields.name),
    permissionNames: readStringArray(fields.permissions),
  }
}

export function extractRoleSpecs(canvas: CanvasSnapshot): RoleSpec[] {
  const items = (canvas.items ?? canvas.sections ?? []) as Array<{ fields?: Record<string, unknown> }>
  return items.map((item) => extractRoleSpec(item.fields ?? {}))
}

export function roleKey(name: string): string {
  return name.trim().toLowerCase()
}

export function findRoleByName(roles: RoleResource[], name: string): RoleResource | null {
  const key = roleKey(name)
  if (!key) return null
  return roles.find((r) => typeof r.attributes?.name === 'string' && roleKey(r.attributes.name) === key) ?? null
}

export function buildRoleBody(spec: RoleSpec): RoleBody {
  return { name: spec.name }
}

/** Resolve declared permission NAMES (case-insensitive, alias-aware) to Datadog permission ids. */
export function resolvePermissionIds(
  all: PermissionRef[],
  names: string[],
): { ids: string[]; unknown: string[] } {
  const byName = new Map<string, string>()
  for (const p of all) {
    byName.set(p.name.toLowerCase(), p.id)
    for (const alias of p.aliases) byName.set(alias.toLowerCase(), p.id)
  }
  const ids: string[] = []
  const unknownNames: string[] = []
  for (const name of names) {
    const id = byName.get(name.trim().toLowerCase())
    if (id) ids.push(id)
    else unknownNames.push(name)
  }
  return { ids, unknown: unknownNames }
}

/** Which declared ids are not yet granted — the additive-only reconcile's grant list. */
export function missingPermissionIds(desired: string[], current: string[]): string[] {
  const currentSet = new Set(current)
  return desired.filter((id) => !currentSet.has(id))
}

export function toCreatePayload(body: RoleBody): { data: { type: 'roles'; attributes: RoleBody } } {
  return { data: { type: 'roles', attributes: body } }
}

export function toUpdatePayload(id: string, body: RoleBody): { data: { type: 'roles'; id: string; attributes: RoleBody } } {
  return { data: { type: 'roles', id, attributes: body } }
}
