import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage } from '../../lib/elastic'
import { buildTagBody, type TagRollbackEntry } from './deploy'

/**
 * Roll back tags using the state captured during deploy:
 *   - tags that were CREATED are deleted (DELETE /api/tags/{id})
 *   - tags that were UPDATED are restored (PUT) to their prior body
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: TagRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        const res = await client.kibana('DELETE', `/api/tags/${encodeURIComponent(entry.id)}`)
        // 404 means it is already gone — the desired end state.
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete tag "${entry.id}": ${elasticErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        const res = await client.kibana('PUT', `/api/tags/${encodeURIComponent(entry.id)}`, {
          body: buildTagBody({
            sectionName: entry.id,
            id: entry.id,
            name: entry.prior.name ?? entry.id,
            color: entry.prior.color ?? '#000000',
            description: entry.prior.description,
          }),
        })
        if (!res.ok) {
          throw new Error(`Failed to restore tag "${entry.id}": ${elasticErrorMessage(res)}`)
        }
      }

      reverted.push(entry.id)
    }

    return { success: true, message: `Rolled back ${reverted.length} tag(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} tag(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
