import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient } from '../../lib/jamfApi'
import { buildCategoryBody, type LiveCategory } from './validate'
import type { CategoryRollbackEntry } from './deploy'

const CATEGORIES_PATH = '/v1/categories'

/**
 * Roll back Jamf Pro categories using the state captured during deploy:
 *   - categories that were created are deleted (DELETE /v1/categories/{id})
 *   - categories that were updated are restored to their captured prior
 *     state (PUT /v1/categories/{id})
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: CategoryRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.request('DELETE', `${CATEGORIES_PATH}/${encodeURIComponent(entry.id)}`)
          if (res.error) throw new Error(`Failed to delete category "${entry.label}": ${res.error}`)
        }
      } else if (entry.id && entry.prior) {
        const res = await client.request(
          'PUT',
          `${CATEGORIES_PATH}/${encodeURIComponent(entry.id)}`,
          priorToBody(entry.prior),
        )
        if (res.error) throw new Error(`Failed to restore category "${entry.label}": ${res.error}`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} Jamf Pro categor${reverted.length === 1 ? 'y' : 'ies'}: ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}

/** Rebuild an update body from a captured prior category state. */
function priorToBody(prior: LiveCategory): Record<string, unknown> {
  return buildCategoryBody({ sectionName: '', name: prior.name ?? '', priority: prior.priority ?? 0 })
}
