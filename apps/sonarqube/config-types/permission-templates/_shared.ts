// Shared helpers for the SonarQube Permission Templates config type (validate + deploy +
// rollback + drift). Pure and network-free so validate.ts and the tests can use it.
//
// A permission template is authored as a name (identity), an optional description, an
// optional project-key pattern (a regex matched against new project keys) and an optional
// set of group grants. Applied over the SonarQube Web API (/api/permissions/*_template).
// SonarQube's update_template addresses a template by `id`, so we upsert by NAME and
// resolve the id from /api/permissions/search_templates at deploy time (ids are not
// stable across versions/restores).
//
// Group grants are authored one per line as `<groupName>: <perm>[, <perm> ...]`. Only the
// groups the operator lists are managed (add/remove of the listed perms) — undeclared
// groups on the template are left untouched, so this never silently strips existing grants.

/** Project-permission keys a template grant may carry. Verify the exact set per version. */
export const PERMISSION_KEYS = new Set(['admin', 'codeviewer', 'issueadmin', 'securityhotspotadmin', 'scan', 'user'])

/** A template as returned by /api/permissions/search_templates ({ permissionTemplates: [...] }). */
export interface SonarPermissionTemplate {
  id?: string
  name?: string
  description?: string
  projectKeyPattern?: string
  [key: string]: unknown
}

/** Unwrap SonarQube's `{ permissionTemplates: [...] }` envelope into a flat array. */
export function templatesFromSearch(payload: unknown): SonarPermissionTemplate[] {
  if (payload && typeof payload === 'object' && Array.isArray((payload as { permissionTemplates?: unknown }).permissionTemplates)) {
    return (payload as { permissionTemplates: SonarPermissionTemplate[] }).permissionTemplates
  }
  return []
}

/** Find a live template by exact name (SonarQube template names are unique). */
export function findTemplate(templates: SonarPermissionTemplate[], name: string): SonarPermissionTemplate | null {
  const n = name.trim()
  return templates.find((t) => String(t.name ?? '').trim() === n) ?? null
}

export interface GroupGrant {
  group: string
  permissions: string[]
}
export interface GroupGrantParse {
  grants: GroupGrant[]
  errors: Array<{ raw: string; code: 'INVALID_GRANT' | 'UNKNOWN_PERMISSION'; message: string }>
}

/**
 * Parse the group-permissions textarea. Each non-blank, non-`#` line is
 * `<groupName>: <perm>[, <perm> ...]` (permissions comma- or space-separated). Permission
 * keys are lower-cased and must be in PERMISSION_KEYS. Repeated groups are merged; repeated
 * permissions are de-duplicated. Malformed lines are reported (never silently dropped).
 */
export function parseGroupPermissions(text: unknown): GroupGrantParse {
  const byGroup = new Map<string, Set<string>>()
  const errors: GroupGrantParse['errors'] = []

  String(text ?? '')
    .split(/\r?\n/)
    .forEach((line) => {
      const t = line.trim()
      if (!t || t.startsWith('#')) return

      const idx = t.indexOf(':')
      if (idx <= 0) {
        errors.push({ raw: t, code: 'INVALID_GRANT', message: `Group grant "${t}" must be "<groupName>: <permission>[, <permission> ...]".` })
        return
      }
      const group = t.slice(0, idx).trim()
      const perms = t
        .slice(idx + 1)
        .split(/[\s,]+/)
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean)

      if (!group || perms.length === 0) {
        errors.push({ raw: t, code: 'INVALID_GRANT', message: `Group grant "${t}" must name a group and at least one permission.` })
        return
      }

      const set = byGroup.get(group) ?? new Set<string>()
      for (const p of perms) {
        if (!PERMISSION_KEYS.has(p)) {
          errors.push({ raw: t, code: 'UNKNOWN_PERMISSION', message: `Permission "${p}" is not one of: ${[...PERMISSION_KEYS].join(', ')}.` })
          continue
        }
        set.add(p)
      }
      if (set.size > 0) byGroup.set(group, set)
    })

  const grants: GroupGrant[] = [...byGroup.entries()].map(([group, set]) => ({ group, permissions: [...set].sort() }))
  return { grants, errors }
}

/** Map a /api/permissions/template_groups response to group name → sorted permission list. */
export function groupPermsFromTemplateGroups(payload: unknown): Map<string, string[]> {
  const groups =
    payload && typeof payload === 'object' && Array.isArray((payload as { groups?: unknown }).groups)
      ? (payload as { groups: Array<{ name?: unknown; permissions?: unknown }> }).groups
      : []
  const map = new Map<string, string[]>()
  for (const g of groups) {
    const name = String(g.name ?? '').trim()
    if (!name) continue
    const perms = Array.isArray(g.permissions) ? (g.permissions as unknown[]).map((p) => String(p)) : []
    map.set(name, [...perms].sort())
  }
  return map
}

export interface GroupReconcile {
  toAdd: Array<{ group: string; permission: string }>
  toRemove: Array<{ group: string; permission: string }>
}

/**
 * Reconcile desired group grants against the live ones, scoped to the DECLARED groups
 * only: add the desired perms a live group is missing, remove the perms it has beyond the
 * desired set. Groups not present in `desired` are never touched.
 */
export function reconcileGroupPerms(desired: GroupGrant[], live: Map<string, string[]>): GroupReconcile {
  const toAdd: GroupReconcile['toAdd'] = []
  const toRemove: GroupReconcile['toRemove'] = []
  for (const grant of desired) {
    const want = new Set(grant.permissions)
    const have = new Set(live.get(grant.group) ?? [])
    for (const p of want) if (!have.has(p)) toAdd.push({ group: grant.group, permission: p })
    for (const p of have) if (!want.has(p)) toRemove.push({ group: grant.group, permission: p })
  }
  return { toAdd, toRemove }
}
