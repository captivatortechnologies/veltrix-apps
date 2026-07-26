import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient, armErrorMessage, SENTINEL_API_VERSION } from '../../lib/sentinel'
import type { DataConnectorRollbackEntry } from './deploy'

/**
 * Roll back data connectors using the state captured during deploy: connectors
 * this deploy created are deleted; connectors it updated are restored to their
 * prior kind/properties via an unconditional PUT.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: DataConnectorRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  try {
    for (const entry of [...previousState].reverse()) {
      const path = client.sentinelPath(`/dataConnectors/${entry.connectorId}`)
      if (!entry.existed) {
        const res = await client.request('DELETE', path, { apiVersion: SENTINEL_API_VERSION })
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete data connector "${entry.connectorId}": ${armErrorMessage(res)}`)
        }
      } else if (entry.prior) {
        const body = { kind: entry.prior.kind, properties: entry.prior.properties }
        const res = await client.request('PUT', path, { apiVersion: SENTINEL_API_VERSION, body })
        if (!res.ok) throw new Error(`Failed to restore data connector "${entry.connectorId}": ${armErrorMessage(res)}`)
      }
      reverted.push(entry.connectorId)
    }
    return { success: true, message: `Rolled back ${reverted.length} data connector(s): ${reverted.join(', ')}` }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    }
  }
}
