import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, pingOneErrorMessage } from '../../lib/pingOne'
import type { PopulationRollbackEntry } from './deploy'

/**
 * Roll back populations using the state captured during deploy:
 *   - populations this deploy CREATED are deleted. PingOne blocks deleting the
 *     default population and blocks deleting a population that still has
 *     users - those errors are surfaced verbatim below; this never retries
 *     the delete.
 *   - populations this deploy UPDATED are PUT back to their captured prior body.
 *
 * KNOWN LIMITATION: a defaultIdentityProvider assignment made during deploy is
 * never restored - PingOne exposes no endpoint to unset it, so rollback can
 * only leave it as-is.
 *
 * Rollback is keyed on the population id PingOne returned, never on the name.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: PopulationRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this population - remove it. A 404 means it is
        // already gone, which is fine. PingOne's own delete-blocking rules
        // (default population, population still has users) are surfaced
        // verbatim rather than retried.
        if (entry.id) {
          const del = await client.request('DELETE', `/populations/${entry.id}`)
          if (!del.ok && del.status !== 404) {
            throw new Error(`Failed to delete population "${entry.name}": ${pingOneErrorMessage(del)}`)
          }
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this population - restore its captured prior body.
        const res = await client.request('PUT', `/populations/${entry.id}`, { body: entry.prior })
        if (!res.ok) {
          throw new Error(`Failed to restore population "${entry.name}": ${pingOneErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} population(s): ${reverted.join(', ')}. Note: any default identity provider assignment made during deploy is not reverted - PingOne has no API to unset it.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} population(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
