import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient, zscalerErrorMessage } from '../../lib/zscaler'
import type { AdminUserRollbackEntry } from './deploy'

/**
 * Roll back ZIA admin users using the state captured during deploy:
 *   - accounts THIS deploy CREATED (existed:false) are DELETED (DELETE /adminUsers/{id})
 *   - accounts that were UPDATED (existed:true) are RESTORED (PUT) to their prior
 *     non-secret body — never deleted
 *
 * ⚠ Rollback NEVER deletes a pre-existing account, so the bootstrap super admin
 * (and every other account this deploy did not create) is protected. It also
 * never restores a password: the password is a WRITE-ONLY secret that was never
 * captured, so a restored account keeps whatever password it already had.
 *
 * Reverting is itself a staged change, so this activates once at the end.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AdminUserRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    // Reverse order so newer changes are undone first.
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        // Only accounts this deploy created are deleted — pre-existing accounts
        // (e.g. the bootstrap super admin) are never touched here.
        if (entry.id != null) {
          const res = await client.zia('DELETE', `/adminUsers/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete admin user "${entry.loginName}": ${zscalerErrorMessage(res)}`)
          }
        }
      } else if (entry.id != null && entry.prior) {
        // Restore the prior NON-SECRET state (no password — it was never captured).
        const restore: Record<string, unknown> = {
          loginName: entry.loginName,
          userName: entry.prior.userName ?? entry.loginName,
          email: entry.prior.email ?? '',
          comments: entry.prior.comments ?? '',
          disabled: entry.prior.disabled ?? false,
        }
        if (entry.prior.roleId != null) restore.role = { id: entry.prior.roleId }
        const res = await client.zia('PUT', `/adminUsers/${entry.id}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore admin user "${entry.loginName}": ${zscalerErrorMessage(res)}`)
        }
      }
      reverted.push(entry.loginName)
    }

    const act = await client.activate()
    if (!act.ok) {
      return {
        success: false,
        message: `Reverted ${reverted.length} admin user(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. Re-run rollback to retry activation.`,
      }
    }

    return {
      success: true,
      message: `Rolled back and activated ${reverted.length} ZIA admin user(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} user(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
