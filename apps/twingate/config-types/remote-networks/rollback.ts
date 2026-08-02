import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTwingateClient, mutationOkError } from '../../lib/twingateApi'
import {
  DELETE_REMOTE_NETWORK_MUTATION,
  UPDATE_REMOTE_NETWORK_MUTATION,
  assertMutationOk,
  priorToUpdateVariables,
  type RemoteNetworkDeleteMutationResponse,
  type RemoteNetworkUpdateMutationResponse,
} from './_shared'
import type { RemoteNetworkRollbackEntry } from './deploy'

/**
 * Roll back Remote Networks using the state captured during deploy:
 *   - networks that were created are deleted (remoteNetworkDelete)
 *   - networks that were updated are restored to their captured prior state
 *     via remoteNetworkUpdate
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTwingateClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: RemoteNetworkRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.graphql<RemoteNetworkDeleteMutationResponse>(DELETE_REMOTE_NETWORK_MUTATION, {
            id: entry.id,
          })
          assertMutationOk(
            res.transportError,
            res.errors,
            mutationOkError(res.data?.remoteNetworkDelete),
            `delete Remote Network "${entry.label}"`,
          )
        }
      } else if (entry.id && entry.prior) {
        const res = await client.graphql<RemoteNetworkUpdateMutationResponse>(
          UPDATE_REMOTE_NETWORK_MUTATION,
          priorToUpdateVariables(entry.id, entry.prior),
        )
        assertMutationOk(
          res.transportError,
          res.errors,
          mutationOkError(res.data?.remoteNetworkUpdate),
          `restore Remote Network "${entry.label}"`,
        )
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} Twingate Remote Network(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
