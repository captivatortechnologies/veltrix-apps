import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGithubClient, githubErrorMessage } from '../../lib/githubApi'
import type { OrgRoleAssignmentRollbackEntry } from './_shared'

/**
 * Undo an org-role-assignments deploy from rollbackData.entries (written by
 * deploy()): remove exactly the assignments this deploy created
 * (existed=false). An assignment that already existed before this deploy
 * (existed=true) is left untouched — this app never revokes a role it did not
 * grant.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { entries?: OrgRoleAssignmentRollbackEntry[] }
  const entries = data.entries ?? []
  if (entries.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let removed = 0
  const failures: string[] = []

  for (const entry of entries) {
    if (entry.existed || entry.roleId == null) continue
    const fullName = `${entry.org}/${entry.team} -> ${entry.roleName}`
    try {
      const res = await client.removeOrgRoleFromTeam(entry.org, entry.team, entry.roleId)
      if (!res.ok && res.status !== 404) throw new Error(`unassign: ${res.status} ${githubErrorMessage(res)}`)
      removed++
    } catch (error) {
      failures.push(`${fullName}: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  if (failures.length > 0) {
    return { success: false, message: `Rolled back ${removed} assignment(s); ${failures.length} failed: ${failures.join(' | ')}` }
  }
  return { success: true, message: `Rolled back organization role assignments: ${removed} removed.` }
}
