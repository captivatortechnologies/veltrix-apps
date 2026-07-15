import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient, zscalerErrorMessage } from '../../lib/zscaler'
import type { AdminRoleRollbackEntry } from './deploy'

/**
 * Roll back ZIA admin roles using the state captured during deploy:
 *   - roles that were created are deleted (DELETE /adminRoles/{id})
 *   - roles that were updated are restored (PUT) to their prior body
 * Built-in roles are never captured during deploy (it throws on a match), so
 * they are never touched here. Reverting is itself a staged change, so this
 * activates once at the end.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AdminRoleRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    // Reverse order so newer changes are undone first.
    for (const entry of [...previousState].reverse()) {
      if (!entry.existed) {
        if (entry.id != null) {
          const res = await client.zia('DELETE', `/adminRoles/${entry.id}`)
          if (res.status !== 404 && !res.ok) {
            throw new Error(`Failed to delete admin role "${entry.name}": ${zscalerErrorMessage(res)}`)
          }
        }
      } else if (entry.id != null && entry.prior) {
        // Restore the full prior object verbatim, but keep the identity name.
        const restore: Record<string, unknown> = { ...entry.prior, name: entry.prior.name ?? entry.name }
        const res = await client.zia('PUT', `/adminRoles/${entry.id}`, { body: restore })
        if (!res.ok) {
          throw new Error(`Failed to restore admin role "${entry.name}": ${zscalerErrorMessage(res)}`)
        }
      }
      reverted.push(entry.name)
    }

    const act = await client.activate()
    if (!act.ok) {
      return {
        success: false,
        message: `Reverted ${reverted.length} admin role(s) but activation failed: ${zscalerErrorMessage(
          act,
        )}. Re-run rollback to retry activation.`,
      }
    }

    return {
      success: true,
      message: `Rolled back and activated ${reverted.length} ZIA admin role(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} role(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
