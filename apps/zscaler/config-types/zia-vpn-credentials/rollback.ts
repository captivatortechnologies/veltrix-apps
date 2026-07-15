import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient, zscalerErrorMessage } from '../../lib/zscaler'
import type { VpnCredentialRollbackEntry } from './deploy'

/**
 * Roll back ZIA VPN credentials using the state captured during deploy:
 *   - credentials that were created are deleted (DELETE /vpnCredentials/{id})
 *   - credentials that were updated are restored (PUT) to their prior NON-SECRET
 *     body (type, identity, comments)
 * Reverting is itself a staged change, so this activates once at the end.
 *
 * ⚠ WRITE-ONLY SECRET LIMITATION: the `preSharedKey` is never returned by ZIA and
 * was never captured, so a restored (updated) credential is NOT re-sent its prior
 * PSK — it keeps whatever key the rolled-back deploy last set. Only the
 * non-secret fields are truly reverted. Created credentials are removed outright,
 * so no secret lingers for those.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: VpnCredentialRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    // Reverse order so newer changes are undone first.
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id != null) {
          const res = await client.zia('DELETE', `/vpnCredentials/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete VPN credential "${entry.identity}": ${zscalerErrorMessage(res)}`)
          }
        }
      } else if (entry.id != null && entry.prior) {
        // Restore the prior NON-SECRET fields. The PSK is deliberately omitted —
        // it was never captured (write-only).
        const restore: Record<string, unknown> = {
          type: entry.prior.type,
          comments: entry.prior.comments ?? '',
        }
        if (entry.prior.type === 'UFQDN') restore.fqdn = entry.prior.fqdn
        else if (entry.prior.type === 'IP') restore.ipAddress = entry.prior.ipAddress
        const res = await client.zia('PUT', `/vpnCredentials/${entry.id}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore VPN credential "${entry.identity}": ${zscalerErrorMessage(res)}`)
        }
      }
      reverted.push(entry.identity)
    }

    const act = await client.activate()
    if (!act.ok) {
      return {
        success: false,
        message: `Reverted ${reverted.length} VPN credential(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. Re-run rollback to retry activation.`,
      }
    }

    return {
      success: true,
      message: `Rolled back and activated ${reverted.length} ZIA VPN credential(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} credential(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
