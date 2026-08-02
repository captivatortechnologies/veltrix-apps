import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTwingateClient, mutationOkError } from '../../lib/twingateApi'
import {
  DELETE_GROUP_MUTATION,
  UPDATE_GROUP_MUTATION,
  assertMutationOk,
  priorToUpdateVariables,
  type GroupDeleteMutationResponse,
  type GroupUpdateMutationResponse,
} from './_shared'
import type { GroupRollbackEntry } from './deploy'

/**
 * Roll back Groups using the state captured during deploy:
 *   - groups that were created are deleted (groupDelete)
 *   - groups that were updated are restored to their captured prior state
 *     (name, isActive, Resource access) via groupUpdate
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTwingateClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: GroupRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.graphql<GroupDeleteMutationResponse>(DELETE_GROUP_MUTATION, { id: entry.id })
          assertMutationOk(res.transportError, res.errors, mutationOkError(res.data?.groupDelete), `delete Group "${entry.label}"`)
        }
      } else if (entry.id && entry.prior) {
        const res = await client.graphql<GroupUpdateMutationResponse>(
          UPDATE_GROUP_MUTATION,
          priorToUpdateVariables(entry.id, entry.prior),
        )
        assertMutationOk(res.transportError, res.errors, mutationOkError(res.data?.groupUpdate), `restore Group "${entry.label}"`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} Twingate Group(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
