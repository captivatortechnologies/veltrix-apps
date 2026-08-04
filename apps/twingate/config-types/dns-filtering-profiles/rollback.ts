import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTwingateClient, mutationOkError } from '../../lib/twingateApi'
import {
  DELETE_DNS_FILTERING_PROFILE_MUTATION,
  UPDATE_DNS_FILTERING_PROFILE_MUTATION,
  assertMutationOk,
  priorToUpdateVariables,
  type DeleteMutationResponse,
  type UpdateMutationResponse,
} from './_shared'
import type { ProfileRollbackEntry } from './deploy'

/**
 * Roll back DNS Filtering Profiles using the state captured during deploy:
 *   - profiles that were created are deleted (dnsFilteringProfileDelete)
 *   - profiles that were updated are restored to their captured prior full
 *     state via dnsFilteringProfileUpdate
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTwingateClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ProfileRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.graphql<DeleteMutationResponse>(DELETE_DNS_FILTERING_PROFILE_MUTATION, { id: entry.id })
          assertMutationOk(
            res.transportError,
            res.errors,
            mutationOkError(res.data?.dnsFilteringProfileDelete),
            `delete DNS Filtering Profile "${entry.label}"`,
          )
        }
      } else if (entry.id && entry.prior) {
        const res = await client.graphql<UpdateMutationResponse>(
          UPDATE_DNS_FILTERING_PROFILE_MUTATION,
          priorToUpdateVariables(entry.id, entry.prior),
        )
        assertMutationOk(
          res.transportError,
          res.errors,
          mutationOkError(res.data?.dnsFilteringProfileUpdate),
          `restore DNS Filtering Profile "${entry.label}"`,
        )
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} Twingate DNS Filtering Profile(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
