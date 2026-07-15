import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient, zscalerErrorMessage } from '../../lib/zscaler'
import type { GreTunnelRollbackEntry } from './deploy'

/**
 * Roll back ZIA GRE tunnels using the state captured during deploy:
 *   - tunnels that were created are deleted (DELETE /greTunnels/{id})
 *   - tunnels that were updated are restored (PUT) to their prior body
 * Reverting is itself a staged change, so this activates once at the end.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: GreTunnelRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    // Reverse order so newer changes are undone first.
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id != null) {
          const res = await client.zia('DELETE', `/greTunnels/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete GRE tunnel "${entry.sourceIp}": ${zscalerErrorMessage(res)}`)
          }
        }
      } else if (entry.id != null && entry.prior) {
        // undefined fields drop out on serialization, so only the captured prior
        // values are restored.
        const restore = {
          sourceIp: entry.prior.sourceIp ?? entry.sourceIp,
          comment: entry.prior.comment ?? '',
          primaryDestVip: entry.prior.primaryDestVip,
          secondaryDestVip: entry.prior.secondaryDestVip,
          withinCountry: entry.prior.withinCountry,
          ipUnnumbered: entry.prior.ipUnnumbered,
        }
        const res = await client.zia('PUT', `/greTunnels/${entry.id}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore GRE tunnel "${entry.sourceIp}": ${zscalerErrorMessage(res)}`)
        }
      }
      reverted.push(entry.sourceIp)
    }

    const act = await client.activate()
    if (!act.ok) {
      return {
        success: false,
        message: `Reverted ${reverted.length} GRE tunnel(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. Re-run rollback to retry activation.`,
      }
    }

    return {
      success: true,
      message: `Rolled back and activated ${reverted.length} ZIA GRE tunnel(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} tunnel(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
