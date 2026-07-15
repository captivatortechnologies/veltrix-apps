import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, cloudflareErrorMessage } from '../../lib/cloudflare'
import { buildItemBody } from './validate'
import type { ListRollbackEntry } from './deploy'

/**
 * Roll back Cloudflare Lists using the state captured during deploy:
 *   - lists that were created are deleted (DELETE /rules/lists/{id})
 *   - lists that were updated have their description and items restored to the
 *     values captured before the deploy overwrote them
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ListRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.account('DELETE', `/rules/lists/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete list "${entry.name}": ${cloudflareErrorMessage(res)}`)
          }
        }
      } else if (entry.id) {
        const patch = await client.account('PATCH', `/rules/lists/${entry.id}`, {
          body: { description: entry.priorDescription ?? '' },
        })
        if (!patch.ok) {
          throw new Error(`Failed to restore list "${entry.name}": ${cloudflareErrorMessage(patch)}`)
        }
        const body = (entry.priorItems ?? []).map((value) => buildItemBody(entry.kind, value))
        const put = await client.account('PUT', `/rules/lists/${entry.id}/items`, { body })
        if (!put.ok) {
          throw new Error(`Failed to restore items for list "${entry.name}": ${cloudflareErrorMessage(put)}`)
        }
      }
      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} list(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} list(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
