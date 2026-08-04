import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGithubClient, githubErrorMessage } from '../../lib/githubApi'
import { restoreBody, type CustomRoleRollbackEntry } from './_shared'

/**
 * Undo a custom-repository-roles deploy from rollbackData.entries (written by
 * deploy()):
 *   - a role that existed before is PATCHed back to its prior state.
 *   - a role THIS deploy created is deleted.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { entries?: CustomRoleRollbackEntry[] }
  const entries = data.entries ?? []
  if (entries.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  let deleted = 0
  const failures: string[] = []

  for (const entry of entries) {
    if (entry.id == null) continue
    const fullName = `${entry.org}/${entry.name}`
    try {
      if (entry.existed && entry.prior) {
        const res = await client.updateCustomRepositoryRole(entry.org, entry.id, restoreBody(entry.prior))
        if (!res.ok) throw new Error(`restore: ${res.status} ${githubErrorMessage(res)}`)
        restored++
      } else if (!entry.existed) {
        const res = await client.deleteCustomRepositoryRole(entry.org, entry.id)
        if (!res.ok && res.status !== 404) throw new Error(`delete: ${res.status} ${githubErrorMessage(res)}`)
        deleted++
      }
    } catch (error) {
      failures.push(`${fullName}: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  if (failures.length > 0) {
    return {
      success: false,
      message: `Rolled back ${restored} restored / ${deleted} deleted; ${failures.length} failed: ${failures.join(' | ')}`,
    }
  }
  return { success: true, message: `Rolled back custom repository roles: ${restored} restored, ${deleted} deleted.` }
}
