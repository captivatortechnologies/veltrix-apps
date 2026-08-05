import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildF5xcClient, f5xcErrorMessage } from '../../lib/f5xc'
import type { OriginPoolRollbackEntry } from './deploy'

const OBJECT_PLURAL = 'origin_pools'

/**
 * Roll back origin pools using the state captured during deploy:
 *   - pools this deploy CREATED are deleted (a 404 on delete is treated as
 *     already-gone, not an error). Note: F5 XC will reject the delete of a
 *     pool still referenced by a Load Balancer's origin pool field - that
 *     rejection is surfaced verbatim, not retried.
 *   - pools this deploy UPDATED are PUT back to their captured prior
 *     { metadata, spec }.
 * Rollback is keyed on NAME - F5 XC objects have no separate id.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildF5xcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: OriginPoolRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        const del = await client.remove(OBJECT_PLURAL, entry.name)
        if (!del.ok && del.status !== 404) {
          throw new Error(`Failed to delete origin pool "${entry.name}": ${f5xcErrorMessage(del)}`)
        }
      } else if (entry.prior) {
        const res = await client.replace(OBJECT_PLURAL, entry.name, entry.prior)
        if (!res.ok) {
          throw new Error(`Failed to restore origin pool "${entry.name}": ${f5xcErrorMessage(res)}`)
        }
      }
      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} origin pool(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} origin pool(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
