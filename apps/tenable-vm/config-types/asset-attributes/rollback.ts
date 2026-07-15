import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient, tenableErrorMessage } from '../../lib/tenable'
import type { AttributeRollbackEntry } from './deploy'

/**
 * Roll back asset-attribute definitions using the state captured during deploy:
 *   - attributes that were created are deleted
 *     (DELETE /api/v3/assets/attributes/{id})
 *   - attributes that were updated are restored (PUT) to their prior description
 *
 * Rollback is keyed on the stable id, never the name. Deleting an attribute
 * definition removes that custom field (and any values assets held for it), so
 * rolling back a freshly-created attribute also drops those per-asset values.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AttributeRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      const label = entry.name

      if (!entry.existed) {
        // Deploy created this attribute — remove it. 404 means it is already
        // gone (or was never created), which is the desired end state.
        if (entry.id) {
          const res = await client.request('DELETE', `/api/v3/assets/attributes/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete attribute "${label}": ${tenableErrorMessage(res)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this attribute — restore the captured prior description
        // (name is immutable, so only the description is restorable).
        const res = await client.request('PUT', `/api/v3/assets/attributes/${entry.id}`, {
          body: { description: entry.prior.description ?? '' },
        })
        if (!res.ok) {
          throw new Error(`Failed to restore attribute "${label}": ${tenableErrorMessage(res)}`)
        }
      }

      reverted.push(label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} asset attribute(s): ${reverted.join(', ')}. Note: deleting an attribute definition also removes any values assets held for it.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} attribute(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
