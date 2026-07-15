import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage } from '../../lib/elastic'
import { SPACES_SPACE, buildSpaceBody, type SpaceRollbackEntry } from './deploy'
import { isProtectedSpaceId } from './validate'

/**
 * Roll back spaces using the state captured during deploy:
 *   - spaces that were CREATED are deleted (DELETE /api/spaces/space/{id})
 *   - spaces that were UPDATED are restored (PUT) to their prior body
 *
 * PROTECTED default: this is the one place a space DELETE happens, so it is the
 * one place the default-space guard is enforced. The default space always
 * pre-exists (deploy can only ever update it, never create it), so it should
 * never appear as a "created" entry — but should the captured state ever say so,
 * we REFUSE to delete the protected default and skip it, rather than remove the
 * built-in space.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: SpaceRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const skipped: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this space — remove it, unless it is the protected
        // default (which can never legitimately be a created space).
        if (isProtectedSpaceId(entry.id)) {
          skipped.push(entry.id)
          continue
        }
        const res = await client.kibana('DELETE', `/api/spaces/space/${encodeURIComponent(entry.id)}`, {
          space: SPACES_SPACE,
        })
        // 404 means it is already gone (or was never created) — the desired end state.
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete space "${entry.id}": ${elasticErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        // Deploy updated this space — restore the captured prior body. Updating
        // the default in place is allowed, so a prior-state restore is fine here.
        const res = await client.kibana('PUT', `/api/spaces/space/${encodeURIComponent(entry.id)}`, {
          body: buildSpaceBody({
            sectionName: entry.id,
            id: entry.id,
            name: entry.prior.name ?? entry.id,
            description: entry.prior.description,
            disabledFeatures: entry.prior.disabledFeatures ?? [],
            solution: entry.prior.solution || undefined,
            initials: entry.prior.initials,
            color: entry.prior.color,
          }),
          space: SPACES_SPACE,
        })
        if (!res.ok) {
          throw new Error(`Failed to restore space "${entry.id}": ${elasticErrorMessage(res)}`)
        }
      }

      reverted.push(entry.id)
    }

    const skipNote = skipped.length
      ? ` Skipped the protected default space${skipped.length > 1 ? 's' : ''}: ${skipped.join(', ')}.`
      : ''
    return {
      success: true,
      message: `Rolled back ${reverted.length} space(s): ${reverted.join(', ')}.${skipNote}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} space(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
