import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildF5xcClient, f5xcErrorMessage } from '../../lib/f5xc'
import type { HealthCheckRollbackEntry } from './deploy'

const OBJECT_PLURAL = 'healthchecks'

/**
 * Roll back health checks using the state captured during deploy:
 *   - health checks this deploy CREATED are deleted (a 404 on delete is
 *     treated as already-gone, not an error).
 *   - health checks this deploy UPDATED are PUT back to their captured prior
 *     { metadata, spec }.
 * Rollback is keyed on NAME - F5 XC health checks have no separate id.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildF5xcClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: HealthCheckRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        const del = await client.remove(OBJECT_PLURAL, entry.name)
        if (!del.ok && del.status !== 404) {
          throw new Error(`Failed to delete health check "${entry.name}": ${f5xcErrorMessage(del)}`)
        }
      } else if (entry.prior) {
        const res = await client.replace(OBJECT_PLURAL, entry.name, entry.prior)
        if (!res.ok) {
          throw new Error(`Failed to restore health check "${entry.name}": ${f5xcErrorMessage(res)}`)
        }
      }
      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} health check(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} health check(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
