// Shared helpers for the Roles config type (deploy + rollback + drift).
//
// REST shape follows /rest/role (docs.splunk.com SOAR PlatformAPI — Role
// Management endpoints): name, description, permissions (array of
// { name, view, edit, delete, execute }). The 9 documented permission
// categories are modeled uniformly with all four flags — the API's own
// permission object accepts the same four optional booleans regardless of
// category (not every flag has an effect on every category, e.g. `execute` on
// `system_settings` is likely a no-op; this mirrors the API's generic shape
// rather than guessing a narrower subset per category). Per-object allow-lists
// (`container_labels`/`repository`/`tenant` scoped to specific ids via `extra`/
// `object_id`) are NOT modeled — see README Coverage. `users` (role membership)
// is intentionally out of scope — see README Coverage.
// GET (list)/POST (create)/POST-<id> (update)/DELETE-<id> confirmed; verify
// against a live SOAR instance.

import type { RecordSpec } from '../../lib/soarRecordEntities'
import { normalizeBool } from '../../lib/soarCommon'

export const PERMISSION_NAMES = [
  'apps',
  'assets',
  'containers',
  'container_labels',
  'repository',
  'tenant',
  'playbooks',
  'system_settings',
  'users_roles',
] as const
export type PermissionName = (typeof PERMISSION_NAMES)[number]

export const PERMISSION_FLAGS = ['view', 'edit', 'delete', 'execute'] as const
export type PermissionFlag = (typeof PERMISSION_FLAGS)[number]

export interface RolePermission {
  name: string
  view: boolean
  edit: boolean
  delete: boolean
  execute: boolean
}

/** The canvas field key for one permission category's flag, e.g. `perm_apps_view`. */
export function permFieldKey(name: PermissionName, flag: PermissionFlag): string {
  return `perm_${name}_${flag}`
}

/** Every canvas field key this type declares, for validation/testing. */
export const ALL_PERM_FIELD_KEYS: string[] = PERMISSION_NAMES.flatMap((name) =>
  PERMISSION_FLAGS.map((flag) => permFieldKey(name, flag)),
)

export function buildPermissions(fields: Record<string, unknown>): RolePermission[] {
  return PERMISSION_NAMES.map((name) => ({
    name,
    view: normalizeBool(fields[permFieldKey(name, 'view')]),
    edit: normalizeBool(fields[permFieldKey(name, 'edit')]),
    delete: normalizeBool(fields[permFieldKey(name, 'delete')]),
    execute: normalizeBool(fields[permFieldKey(name, 'execute')]),
  }))
}

/**
 * Canonical `{ categoryName: flags }` map — every one of the 9 categories
 * present, defaulted to all-false when SOAR's response (or a stale
 * declaration) omits one. Used for order-independent drift comparison, since
 * SOAR's `permissions` array order is not guaranteed to match ours.
 */
export function permsToMap(perms: unknown): Record<string, { view: boolean; edit: boolean; delete: boolean; execute: boolean }> {
  const rows = Array.isArray(perms) ? (perms as Array<Record<string, unknown>>) : []
  const byName = new Map(rows.map((r) => [String(r.name ?? ''), r]))
  const out: Record<string, { view: boolean; edit: boolean; delete: boolean; execute: boolean }> = {}
  for (const name of PERMISSION_NAMES) {
    const row = byName.get(name) ?? {}
    out[name] = {
      view: normalizeBool(row.view),
      edit: normalizeBool(row.edit),
      delete: normalizeBool(row.delete),
      execute: normalizeBool(row.execute),
    }
  }
  return out
}

export interface SoarRole {
  id?: number | string
  name?: string
  description?: string
  permissions?: RolePermission[]
  [key: string]: unknown
}

/** Find a live role by name (case-insensitive — the stable identity). */
export function findRoleByName(roles: SoarRole[], name: string): SoarRole | null {
  const target = name.trim().toLowerCase()
  if (!target) return null
  return roles.find((r) => String(r.name ?? '').trim().toLowerCase() === target) ?? null
}

export function buildRoleRecord(fields: Record<string, unknown>): RecordSpec {
  const name = String(fields.name ?? '').trim()
  if (!name) return { id: '', body: null, error: null }

  return {
    id: name,
    body: {
      name,
      description: String(fields.description ?? '').trim(),
      permissions: buildPermissions(fields),
    },
    error: null,
  }
}
