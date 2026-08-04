import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGithubClient, githubErrorMessage } from '../../lib/githubApi'
import { restoreBody, type BranchProtectionRollbackEntry } from './_shared'

/**
 * Undo a branch-protection-classic deploy from rollbackData.entries (written
 * by deploy()):
 *   - a branch that was protected before is PUT back to its prior full state.
 *   - a branch THIS deploy protected for the first time has protection removed
 *     (DELETE).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { entries?: BranchProtectionRollbackEntry[] }
  const entries = data.entries ?? []
  if (entries.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildGithubClient(component.hostname, credential, settings ?? {})
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  let removed = 0
  const failures: string[] = []

  for (const entry of entries) {
    const parts = entry.repository.split('/')
    if (parts.length !== 2) continue
    const [owner, repo] = parts
    const label = `${entry.repository}@${entry.branch}`

    try {
      if (entry.existed && entry.prior) {
        const res = await client.updateBranchProtection(owner, repo, entry.branch, restoreBody(entry.prior))
        if (!res.ok) throw new Error(`restore: ${res.status} ${githubErrorMessage(res)}`)
        restored++
      } else if (!entry.existed) {
        const res = await client.deleteBranchProtection(owner, repo, entry.branch)
        if (!res.ok && res.status !== 404) throw new Error(`unprotect: ${res.status} ${githubErrorMessage(res)}`)
        removed++
      }
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  if (failures.length > 0) {
    return {
      success: false,
      message: `Rolled back ${restored} restored / ${removed} unprotected; ${failures.length} failed: ${failures.join(' | ')}`,
    }
  }
  return { success: true, message: `Rolled back branch protection: ${restored} restored, ${removed} unprotected.` }
}
