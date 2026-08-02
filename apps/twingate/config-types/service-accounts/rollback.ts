import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTwingateClient, mutationOkError } from '../../lib/twingateApi'
import {
  DELETE_SERVICE_ACCOUNT_MUTATION,
  UPDATE_SERVICE_ACCOUNT_MUTATION,
  assertMutationOk,
  priorToUpdateVariables,
  type ServiceAccountDeleteMutationResponse,
  type ServiceAccountUpdateMutationResponse,
} from './_shared'
import type { ServiceAccountRollbackEntry } from './deploy'

/**
 * Roll back Service Accounts using the state captured during deploy:
 *   - accounts that were created are deleted (serviceAccountDelete)
 *   - accounts that were updated are restored to their captured prior name
 *     via serviceAccountUpdate
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTwingateClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ServiceAccountRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.graphql<ServiceAccountDeleteMutationResponse>(DELETE_SERVICE_ACCOUNT_MUTATION, {
            id: entry.id,
          })
          assertMutationOk(
            res.transportError,
            res.errors,
            mutationOkError(res.data?.serviceAccountDelete),
            `delete Service Account "${entry.label}"`,
          )
        }
      } else if (entry.id && entry.prior) {
        const res = await client.graphql<ServiceAccountUpdateMutationResponse>(
          UPDATE_SERVICE_ACCOUNT_MUTATION,
          priorToUpdateVariables(entry.id, entry.prior),
        )
        assertMutationOk(
          res.transportError,
          res.errors,
          mutationOkError(res.data?.serviceAccountUpdate),
          `restore Service Account "${entry.label}"`,
        )
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} Twingate Service Account(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
