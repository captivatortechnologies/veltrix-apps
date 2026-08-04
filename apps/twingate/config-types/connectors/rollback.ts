import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTwingateClient, mutationOkError } from '../../lib/twingateApi'
import {
  DELETE_CONNECTOR_MUTATION,
  UPDATE_CONNECTOR_MUTATION,
  assertMutationOk,
  priorToUpdateVariables,
  type ConnectorDeleteMutationResponse,
  type ConnectorUpdateMutationResponse,
} from './_shared'
import type { ConnectorRollbackEntry } from './deploy'

/**
 * Roll back Connectors using the state captured during deploy:
 *   - connectors that were created are deleted (connectorDelete)
 *   - connectors that were updated are restored to their captured prior
 *     name / status-notifications state via connectorUpdate
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTwingateClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: ConnectorRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id) {
          const res = await client.graphql<ConnectorDeleteMutationResponse>(DELETE_CONNECTOR_MUTATION, { id: entry.id })
          assertMutationOk(res.transportError, res.errors, mutationOkError(res.data?.connectorDelete), `delete Connector "${entry.label}"`)
        }
      } else if (entry.id && entry.prior) {
        const res = await client.graphql<ConnectorUpdateMutationResponse>(
          UPDATE_CONNECTOR_MUTATION,
          priorToUpdateVariables(entry.id, entry.prior),
        )
        assertMutationOk(res.transportError, res.errors, mutationOkError(res.data?.connectorUpdate), `restore Connector "${entry.label}"`)
      }
      reverted.push(entry.label)
    }

    return { success: true, message: `Rolled back ${reverted.length} Twingate Connector(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
