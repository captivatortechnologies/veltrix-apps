import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSonarqubeUrl, buildAuthHeader, getJson } from '../../lib/sonarqubeApi'
import { parsePermissions, reconcile, fetchAllGroupPerms, type GroupsActionPage } from './_shared'

/**
 * Drift for global permissions: compare each declared group's permission list against its
 * live GLOBAL grants. Read-only:
 *   GET /api/permissions/groups (internal, since 5.2, paginated) → live group→GLOBAL-permission
 *   map (no projectId/projectKey sent)
 * A declared-but-not-granted permission is one diff ("granted" expected, "not granted"
 * actual); a granted-but-undeclared permission on a DECLARED group is the reverse. Groups
 * never mentioned on this canvas are never inspected. Best-effort — a read failure yields no
 * drift rather than a false positive. Verified live against a running SonarQube instance's
 * own `api/webservices` reflection endpoints.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildSonarqubeUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live
  try {
    live = await fetchAllGroupPerms((page, pageSize) => getJson<GroupsActionPage>(`${base}/api/permissions/groups?p=${page}&ps=${pageSize}`, headers))
  } catch {
    return { hasDrift: false, diffs } // can't read live grants — skip rather than assert drift
  }

  for (const item of items) {
    const groupName = String(item.fields.groupName ?? '').trim()
    if (!groupName) continue

    const { permissions: desired } = parsePermissions(item.fields.permissions)
    const { toAdd, toRemove } = reconcile(desired, live.get(groupName) ?? [])
    for (const permission of toAdd) {
      diffs.push({ field: `${groupName}.${permission}`, expected: `${permission} granted`, actual: 'not granted', severity: 'warning' })
    }
    for (const permission of toRemove) {
      diffs.push({ field: `${groupName}.${permission}`, expected: `${permission} not granted`, actual: 'granted', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
