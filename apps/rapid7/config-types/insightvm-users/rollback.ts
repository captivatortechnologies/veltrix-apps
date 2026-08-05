import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient, insightVMErrorMessage } from '../../lib/insightvm'
import type { UserRollbackEntry } from './deploy'

/**
 * Roll back console users using the state captured during deploy:
 *   - users that were created are deleted (DELETE /users/{id})
 *   - users that were UPDATED are intentionally left as deployed
 *
 * ⚠ LIMITATION: the console requires a password on every write, and the write-
 * only password is never captured (masked on read, never stored). An updated
 * user therefore cannot be safely restored to its prior identity/role/access —
 * doing so would require re-submitting a password, and rollback has no prior
 * value to submit. If a deploy that updated existing users needs to be undone,
 * revert their login/name/email/role/site/asset-group access manually in the
 * console (see rollbackData.previousState[].prior for the values to restore).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: UserRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const created = previousState.filter((e) => !e.existed && e.id != null)
  const updated = previousState.filter((e) => e.existed)
  const reverted: string[] = []

  try {
    for (const entry of [...created].reverse()) {
      const res = await client.request('DELETE', `/users/${entry.id}`)
      if (res.status !== 404 && !res.ok) {
        throw new Error(`Failed to delete user "${entry.label}": ${insightVMErrorMessage(res)}`)
      }
      reverted.push(entry.label)
    }

    const skippedNote =
      updated.length > 0
        ? ` ${updated.length} previously-existing user(s) updated by this deploy were left as-is — see the note in rollback.ts for why: ${updated
            .map((e) => e.label)
            .join(', ')}.`
        : ''

    return {
      success: true,
      message:
        reverted.length > 0
          ? `Rolled back ${reverted.length} created user(s): ${reverted.join(', ')}.${skippedNote}`
          : `Nothing to delete — no users were created by this deployment.${skippedNote}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${created.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
