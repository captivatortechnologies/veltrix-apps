import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient } from '../../lib/falcon'
import { deleteEntity } from '../../lib/entityAdapter'
import {
  INSTALLATION_TOKEN_ENDPOINTS,
  findTokenByLabel,
  updateToken,
  type InstallationTokenRollbackEntry,
} from './deploy'

/**
 * Roll back installation tokens using the state captured during deploy:
 *   - tokens that were created are deleted (the true inverse of create)
 *   - tokens that were updated are patched back to their prior label, expiry,
 *     and revoke state (restoring revoked:false un-revokes a token)
 *
 * Delete is only ever applied to tokens this deploy CREATED — an update is
 * always reversed with a reversible PATCH, never a hard delete.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: InstallationTokenRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        // Deploy created this token — remove it. Re-resolve by label so a
        // concurrent delete makes this a no-op instead of a hard error.
        const live = await findTokenByLabel(client, entry.label)
        if (live?.id) {
          await deleteEntity(client, INSTALLATION_TOKEN_ENDPOINTS, live.id)
        }
      } else if (entry.id && entry.prior) {
        // Deploy updated this token — restore the captured prior values. An
        // empty prior expiry is omitted (it cannot be cleared via PATCH).
        const restore: Record<string, unknown> = {
          label: entry.prior.label,
          revoked: entry.prior.revoked,
        }
        if (entry.prior.expiresTimestamp) restore.expires_timestamp = entry.prior.expiresTimestamp
        await updateToken(client, entry.id, restore)
      }

      reverted.push(entry.label)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} installation token(s): ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} token(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
