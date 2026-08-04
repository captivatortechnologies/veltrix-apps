import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSonarqubeUrl, buildAuthHeader, getJson, postForm } from '../../lib/sonarqubeApi'
import { reconcile, fetchAllGroupPerms, type GroupPermsMap, type GroupsActionPage } from './_shared'

/**
 * Undo a global-permissions deploy from rollbackData (written by deploy()): re-fetch the
 * CURRENT live group→GLOBAL-permission map (permissions can't be assumed unchanged since
 * deploy ran) and, per recorded `{ groupName, priorPermissions }` entry, reconcile that
 * group's current permissions back to exactly its prior set — add what's missing, remove
 * what's extra — via POST /api/permissions/add_group and /remove_group (never with a
 * projectId/projectKey, keeping the scope GLOBAL). Best-effort — a failure on one group does
 * not abort the rest.
 */
interface GroupEntry {
  groupName: string
  priorPermissions: string[]
}

async function liveGlobalGroupPerms(base: string, headers: Record<string, string>): Promise<GroupPermsMap> {
  try {
    return await fetchAllGroupPerms((page, pageSize) => getJson<GroupsActionPage>(`${base}/api/permissions/groups?p=${page}&ps=${pageSize}`, headers))
  } catch {
    return new Map()
  }
}

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as { groups?: GroupEntry[] }
  const groups = data.groups ?? []
  if (groups.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for global permission rollback' }
  }

  const base = buildSonarqubeUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)
  const live = await liveGlobalGroupPerms(base, headers)

  let restored = 0
  const failures: string[] = []

  for (const group of groups) {
    try {
      const current = live.get(group.groupName) ?? []
      const { toAdd, toRemove } = reconcile(group.priorPermissions, current)
      for (const permission of toAdd) {
        await postForm(`${base}/api/permissions/add_group`, headers, { groupName: group.groupName, permission })
      }
      for (const permission of toRemove) {
        await postForm(`${base}/api/permissions/remove_group`, headers, { groupName: group.groupName, permission })
      }
      restored++
    } catch (error) {
      failures.push(`${group.groupName}: ${error instanceof Error ? error.message : 'error'}`)
    }
  }

  if (failures.length > 0) {
    return { success: false, message: `Rollback partially failed: ${restored} group(s) restored. Errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back global permissions for ${restored} group(s).` }
}
