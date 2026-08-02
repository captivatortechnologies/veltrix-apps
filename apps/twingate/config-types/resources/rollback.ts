import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTwingateClient, mutationOkError } from '../../lib/twingateApi'
import {
  DELETE_RESOURCE_MUTATION,
  UPDATE_RESOURCE_MUTATION,
  assertMutationOk,
  priorToUpdateVariables,
  type ResourceDeleteMutationResponse,
  type ResourceUpdateMutationResponse,
} from './_shared'
import type { ResourceRollbackEntry } from './deploy'

/**
 * Roll back Resources using the state captured during deploy:
 *   - resources that were created are deleted (resourceDelete)
 *   - resources that were updated are restored to their captured prior full
 *     state via resourceUpdate (address, remote network, protocols, alias,
 *     visibility flags and group access all rebuilt from the captured read)
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTwingateClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ResourceRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.graphql<ResourceDeleteMutationResponse>(DELETE_RESOURCE_MUTATION, { id: entry.id })
          assertMutationOk(
            res.transportError,
            res.errors,
            mutationOkError(res.data?.resourceDelete),
            `delete resource "${entry.label}"`,
          )
        }
      } else if (entry.id && entry.prior) {
        const res = await client.graphql<ResourceUpdateMutationResponse>(
          UPDATE_RESOURCE_MUTATION,
          priorToUpdateVariables(entry.id, entry.prior),
        )
        assertMutationOk(
          res.transportError,
          res.errors,
          mutationOkError(res.data?.resourceUpdate),
          `restore resource "${entry.label}"`,
        )
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} Twingate resource(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
