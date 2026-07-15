import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient, tenableErrorMessage } from '../../lib/tenable'
import type { NetworkRollbackEntry } from './deploy'

/**
 * Roll back networks using the state captured during deploy:
 *   - networks that were created are deleted (DELETE /networks/{uuid})
 *   - networks that were updated are restored (PUT) to their prior body
 *
 * Rollback keys on the stable uuid, never the name. The built-in default
 * network is never in this state (validate refuses its reserved name), so a
 * rollback never attempts the forbidden delete/update of the default network.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: NetworkRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this network — remove it. 404 means it is already gone
        // (or was never created), which is the desired end state.
        if (entry.uuid) {
          const res = await client.request('DELETE', `/networks/${entry.uuid}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete network "${entry.name}": ${tenableErrorMessage(res)}`)
          }
        }
      } else if (entry.uuid && entry.prior) {
        // Deploy updated this network — restore the captured prior body.
        const restore: Record<string, unknown> = {}
        if (entry.prior.name !== undefined) restore.name = entry.prior.name
        if (entry.prior.description !== undefined) restore.description = entry.prior.description
        if (entry.prior.assets_ttl_days !== undefined) restore.assets_ttl_days = entry.prior.assets_ttl_days

        const res = await client.request('PUT', `/networks/${entry.uuid}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore network "${entry.name}": ${tenableErrorMessage(res)}`)
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} network(s): ${reverted.join(', ')}. Note: deleting a network removes its scanner/asset partition from the tenant.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} network(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
