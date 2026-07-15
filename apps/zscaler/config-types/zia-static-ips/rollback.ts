import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient, zscalerErrorMessage } from '../../lib/zscaler'
import type { StaticIpRollbackEntry } from './deploy'

/**
 * Roll back ZIA static IPs using the state captured during deploy:
 *   - static IPs that were created are deleted (DELETE /staticIP/{id})
 *   - static IPs that were updated are restored (PUT) to their prior body
 * Reverting is itself a staged change, so this activates once at the end.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: StaticIpRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    // Reverse order so newer changes are undone first.
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id != null) {
          const res = await client.zia('DELETE', `/staticIP/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete static IP "${entry.ipAddress}": ${zscalerErrorMessage(res)}`)
          }
        }
      } else if (entry.id != null && entry.prior) {
        const prior = entry.prior
        const restore: Record<string, unknown> = {
          ipAddress: prior.ipAddress ?? entry.ipAddress,
          comment: prior.comment ?? '',
          geoOverride: prior.geoOverride === true,
          routableIP: prior.routableIP !== false,
        }
        // Only restore manual coordinates if the prior state had a geo override.
        if (prior.geoOverride) {
          if (prior.latitude !== undefined) restore.latitude = prior.latitude
          if (prior.longitude !== undefined) restore.longitude = prior.longitude
        }
        const res = await client.zia('PUT', `/staticIP/${entry.id}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore static IP "${entry.ipAddress}": ${zscalerErrorMessage(res)}`)
        }
      }
      reverted.push(entry.ipAddress)
    }

    const act = await client.activate()
    if (!act.ok) {
      return {
        success: false,
        message: `Reverted ${reverted.length} static IP(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. Re-run rollback to retry activation.`,
      }
    }

    return {
      success: true,
      message: `Rolled back and activated ${reverted.length} ZIA static IP(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} static IP(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
