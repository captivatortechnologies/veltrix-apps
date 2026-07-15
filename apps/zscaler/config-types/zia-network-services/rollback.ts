import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient, zscalerErrorMessage } from '../../lib/zscaler'
import type { NetworkServiceRollbackEntry } from './deploy'

/**
 * Roll back ZIA network services using the state captured during deploy:
 *   - services that were created are deleted (DELETE /networkServices/{id})
 *   - services that were updated are restored (PUT) to their prior body
 * Predefined services are never captured during deploy (it throws on a match),
 * so they are never touched here. Reverting is itself a staged change, so this
 * activates once at the end.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: NetworkServiceRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    // Reverse order so newer changes are undone first.
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id != null) {
          const res = await client.zia('DELETE', `/networkServices/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete network service "${entry.name}": ${zscalerErrorMessage(res)}`)
          }
        }
      } else if (entry.id != null && entry.prior) {
        const restore: Record<string, unknown> = {
          name: entry.prior.name ?? entry.name,
          description: entry.prior.description ?? '',
          type: entry.prior.type ?? 'CUSTOM',
        }
        if (entry.prior.destTcpPorts) restore.destTcpPorts = entry.prior.destTcpPorts
        if (entry.prior.destUdpPorts) restore.destUdpPorts = entry.prior.destUdpPorts
        const res = await client.zia('PUT', `/networkServices/${entry.id}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore network service "${entry.name}": ${zscalerErrorMessage(res)}`)
        }
      }
      reverted.push(entry.name)
    }

    const act = await client.activate()
    if (!act.ok) {
      return {
        success: false,
        message: `Reverted ${reverted.length} network service(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. Re-run rollback to retry activation.`,
      }
    }

    return {
      success: true,
      message: `Rolled back and activated ${reverted.length} ZIA network service(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} service(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
