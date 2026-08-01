import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSemgrepClient, projectFromResponse, semgrepWriteError } from '../../lib/semgrepApi'
import { reconcileTags, type ProjectRollbackEntry } from './deploy'

/**
 * Undo a project-settings deploy from rollbackData.previous (written by deploy()):
 * per project, restore the prior primary branch (PATCH primary_branch) and, when
 * the deploy managed tags, reconcile the tag set back to what it was before. The
 * live tag set is re-read so the reconcile computes the exact add/remove needed.
 * A prior primary branch that was unset is left as-is (Semgrep has no clean
 * "unset" for primary_branch — the safe move is not to touch it).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { credential, settings } = ctx
  const data = (ctx.rollbackData ?? {}) as { previous?: ProjectRollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for project rollback' }
  }

  const built = buildSemgrepClient(credential, settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built
  if (!client.hasSlug) {
    return { success: false, message: 'No Semgrep deployment slug set — configure the "Deployment Slug" app setting.' }
  }

  const restored: string[] = []

  try {
    for (const entry of previous) {
      const getRes = await client.getProject(entry.projectName)
      if (!getRes.ok) continue // project gone or unreadable — nothing safe to restore
      const live = projectFromResponse(getRes)
      const liveTags = Array.isArray(live?.tags) ? (live!.tags as string[]) : []

      if (entry.priorPrimaryBranch) {
        const res = await client.updateProject(entry.projectName, { primary_branch: entry.priorPrimaryBranch })
        const err = semgrepWriteError(res)
        if (err) return { success: false, message: `Rollback failed for "${entry.projectName}": ${err}` }
      }

      if (entry.manageTags) {
        const err = await reconcileTags(client, entry.projectName, entry.priorTags, liveTags)
        if (err) return { success: false, message: `Rollback failed: ${err}` }
      }

      restored.push(entry.projectName)
    }

    return { success: true, message: `Rolled back ${restored.length} project(s): ${restored.join(', ') || '(none)'}` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
