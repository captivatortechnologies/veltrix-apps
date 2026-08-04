import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGithubClient, githubErrorMessage } from '../../lib/githubApi'
import type { OrgMemberPrivilegesPrevious } from './_shared'

/**
 * Undo an org-member-privileges deploy from rollbackData.previous (written by
 * deploy()): PATCH each organization's member privileges back to their prior
 * values.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: OrgMemberPrivilegesPrevious[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  const failures: string[] = []

  for (const entry of previous) {
    try {
      const res = await client.updateOrg(entry.org, { ...entry.prior })
      if (!res.ok) throw new Error(`update org: ${res.status} ${githubErrorMessage(res)}`)
      restored++
    } catch (error) {
      failures.push(`${entry.org}: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  if (failures.length > 0) {
    return { success: false, message: `Rolled back ${restored} org(s); ${failures.length} failed: ${failures.join(' | ')}` }
  }
  return { success: true, message: `Rolled back member privileges: ${restored} org(s) restored.` }
}
