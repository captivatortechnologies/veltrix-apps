// Shared helpers for the SonarQube Global Permissions config type (validate + deploy +
// rollback + drift). Pure and network-free so validate.ts and the tests can use it.
//
// A global permission grant is authored as a group name (identity — a real group name, or
// the literal `anyone`, case-insensitive) plus a free-text list of INSTANCE-WIDE permission
// keys. Applied over the SonarQube Web API (/api/permissions/add_group, /remove_group) with
// NEITHER `projectId` NOR `projectKey` sent, which is what scopes the call to GLOBAL
// permissions rather than a project. This is distinct from the permission-templates config
// type, which manages named templates auto-applied to matching NEW projects — this type
// grants permissions DIRECTLY, right now, at the instance level.
//
// Only GROUP grants are in scope for this release; per-USER-login overrides are an
// intentional exclusion — group-based RBAC is the standard, auditable pattern SonarQube
// itself recommends, while per-user overrides are a much larger, noisier surface (every
// login is a potential grant target, with no template-style reconciliation story) better
// left to a future release.
//
// Verified live against a running SonarQube instance's own `api/webservices` reflection
// endpoints (`api/webservices/list?include_internals=true`, `api/webservices/response_example`):
//   - add_group / remove_group (public, since 5.2): groupName + permission; projectId/
//     projectKey both optional and omitted here to target the GLOBAL scope.
//   - groups (INTERNAL, since 5.2): the only way to read back current global group grants —
//     there is no public non-internal equivalent, same situation permission-templates faces
//     with template_groups (also internal). Defaults to GLOBAL scope when projectId/
//     projectKey are omitted. Response shape: { paging: { pageIndex, pageSize, total },
//     groups: [{ name, permissions, id?, description?, managed? }] }.

/** Global permission keys the live SonarQube `api/permissions` action set accepts. */
export const GLOBAL_PERMISSION_KEYS = new Set([
  'admin',
  'gateadmin',
  'profileadmin',
  'provisioning',
  'scan',
  'applicationcreator',
  'portfoliocreator',
])

export interface PermissionParseError {
  code: 'UNKNOWN_PERMISSION'
  message: string
}
export interface PermissionParseResult {
  permissions: string[]
  errors: PermissionParseError[]
}

/**
 * Parse the permissions textarea: tokens are split on commas, whitespace and newlines
 * (any mix), blank tokens and `#`-comment lines are ignored, remaining tokens are
 * lower-cased and de-duplicated. A token outside GLOBAL_PERMISSION_KEYS is reported
 * (never silently dropped) but parsing continues over the rest.
 */
export function parsePermissions(text: unknown): PermissionParseResult {
  const seen = new Set<string>()
  const errors: PermissionParseError[] = []

  String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .join(' ')
    .split(/[\s,]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
    .forEach((token) => {
      if (!GLOBAL_PERMISSION_KEYS.has(token)) {
        errors.push({ code: 'UNKNOWN_PERMISSION', message: `Permission "${token}" is not one of: ${[...GLOBAL_PERMISSION_KEYS].join(', ')}.` })
        return
      }
      seen.add(token)
    })

  return { permissions: [...seen].sort(), errors }
}

/** Group name → its sorted, live GLOBAL permission list. */
export type GroupPermsMap = Map<string, string[]>

/** One page of the `api/permissions/groups` response. */
export interface GroupsActionPage {
  paging?: { pageIndex?: number; pageSize?: number; total?: number }
  groups?: Array<{ name?: unknown; permissions?: unknown; [key: string]: unknown }>
}

/** Unwrap one `api/permissions/groups` page's `{ groups: [{name, permissions}] }` shape. */
export function groupsFromGroupsAction(payload: unknown): GroupPermsMap {
  const groups =
    payload && typeof payload === 'object' && Array.isArray((payload as { groups?: unknown }).groups)
      ? (payload as { groups: Array<{ name?: unknown; permissions?: unknown }> }).groups
      : []
  const map: GroupPermsMap = new Map()
  for (const g of groups) {
    const name = String(g.name ?? '').trim()
    if (!name) continue
    const perms = Array.isArray(g.permissions) ? (g.permissions as unknown[]).map((p) => String(p)) : []
    map.set(name, [...perms].sort())
  }
  return map
}

const GROUPS_PAGE_SIZE = 100
const GROUPS_MAX_PAGES = 20 // safety bound: 20 pages * 100 = 2000 groups

/**
 * Page through `api/permissions/groups` and fold every page into one group→permissions
 * map, continuing while a page came back full (`groups.length === pageSize`) and the
 * paging total says there is more, capped at GROUPS_MAX_PAGES. `fetchPage` is supplied by
 * the caller (deploy/rollback/driftDetect each wrap their own `getJson` call), so this
 * orchestrator carries no transport concern and stays trivially testable with a mock.
 */
export async function fetchAllGroupPerms(fetchPage: (page: number, pageSize: number) => Promise<GroupsActionPage>): Promise<GroupPermsMap> {
  const map: GroupPermsMap = new Map()
  let page = 1

  while (page <= GROUPS_MAX_PAGES) {
    const payload = await fetchPage(page, GROUPS_PAGE_SIZE)
    for (const [name, perms] of groupsFromGroupsAction(payload)) map.set(name, perms)

    const returned = Array.isArray(payload?.groups) ? payload.groups.length : 0
    const total = typeof payload?.paging?.total === 'number' ? payload.paging.total : returned
    if (returned < GROUPS_PAGE_SIZE || page * GROUPS_PAGE_SIZE >= total) break
    page++
  }

  return map
}

export interface PermsReconcile {
  toAdd: string[]
  toRemove: string[]
}

/** Plain set-diff between the desired permission list and one group's live permission list. */
export function reconcile(desired: string[], live: string[]): PermsReconcile {
  const want = new Set(desired)
  const have = new Set(live)
  return {
    toAdd: [...want].filter((p) => !have.has(p)),
    toRemove: [...have].filter((p) => !want.has(p)),
  }
}
