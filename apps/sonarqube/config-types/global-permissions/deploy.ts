import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSonarqubeUrl, buildAuthHeader, getJson, postForm } from '../../lib/sonarqubeApi'
import { parsePermissions, reconcile, fetchAllGroupPerms, type GroupPermsMap, type GroupsActionPage } from './_shared'

/**
 * Deploy SonarQube global permissions over the Web API (/api/permissions):
 *   read (context): GET  /api/permissions/groups (internal, since 5.2, paginated) → live
 *                        group→GLOBAL-permission map (no projectId/projectKey sent)
 *   grant:          POST /api/permissions/add_group     (since 5.2) { groupName, permission }
 *   revoke:         POST /api/permissions/remove_group  (since 5.2) { groupName, permission }
 * Neither add_group nor remove_group is ever sent a projectId/projectKey here — omitting both
 * is exactly what scopes the call to GLOBAL permissions rather than a project.
 *
 * Only groups DECLARED on this canvas are reconciled: a group's full live global-permission
 * set is read, diffed against the declared permission list, and just the delta (toAdd /
 * toRemove) is applied — a group never mentioned on this canvas is left untouched. Verified
 * live against a running SonarQube instance's own `api/webservices` reflection endpoints.
 *
 * rollbackData records, per declared group, its FULL prior permission list (not just the
 * delta) so rollback can restore it exactly regardless of what a later deploy changes.
 */
async function liveGlobalGroupPerms(base: string, headers: Record<string, string>): Promise<GroupPermsMap> {
  try {
    return await fetchAllGroupPerms((page, pageSize) => getJson<GroupsActionPage>(`${base}/api/permissions/groups?p=${page}&ps=${pageSize}`, headers))
  } catch {
    return new Map()
  }
}

interface GroupEntry {
  groupName: string
  priorPermissions: string[]
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for global permission deployment' }
  }

  const base = buildSonarqubeUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const groups: GroupEntry[] = []
  const applied: string[] = []

  try {
    const live = await liveGlobalGroupPerms(base, headers)

    for (const item of items) {
      const groupName = String(item.fields.groupName ?? '').trim()
      if (!groupName) continue

      const { permissions: desired } = parsePermissions(item.fields.permissions)
      const priorPermissions = live.get(groupName) ?? []
      const { toAdd, toRemove } = reconcile(desired, priorPermissions)

      for (const permission of toAdd) {
        await postForm(`${base}/api/permissions/add_group`, headers, { groupName, permission })
      }
      for (const permission of toRemove) {
        await postForm(`${base}/api/permissions/remove_group`, headers, { groupName, permission })
      }

      groups.push({ groupName, priorPermissions })
      applied.push(groupName)
    }

    return {
      success: true,
      message: `Reconciled global permissions for ${applied.length} group(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { groups },
    }
  } catch (error) {
    return {
      success: false,
      message: `Global permission deploy failed after ${applied.length} group(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { groups },
    }
  }
}
