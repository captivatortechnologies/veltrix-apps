import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient, akeylessErrorMessage } from '../../lib/akeyless'
import type { RotatedSecretRollbackEntry } from './deploy'

/**
 * Roll back rotated secret configs using the state captured during deploy:
 *   - configs that were created ARE deleted (POST /rotated-secret-delete,
 *     tolerate 404).
 *   - configs that already existed and were UPDATED cannot be reverted -
 *     Akeyless has no "get rotated-secret configuration" endpoint (see
 *     canvas.yaml header), so this app never captured their prior settings
 *     to restore. This is surfaced clearly rather than silently doing
 *     nothing.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildAkeylessClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: RotatedSecretRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const notRestorable: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        const res = await client.request('/rotated-secret-delete', { name: entry.name })
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete rotated secret config "${entry.name}": ${akeylessErrorMessage(res)}`)
        }
        reverted.push(entry.name)
      } else {
        notRestorable.push(entry.name)
      }
    }

    const parts: string[] = []
    if (reverted.length) parts.push(`Deleted ${reverted.length} newly-created rotated secret config(s): ${reverted.join(', ')}.`)
    if (notRestorable.length) {
      parts.push(
        `${notRestorable.length} pre-existing config(s) were updated by this deploy and could NOT be reverted ` +
          `(Akeyless has no read endpoint for rotator settings): ${notRestorable.join(', ')}.`,
      )
    }
    return { success: true, message: parts.join(' ') || 'Nothing to roll back.' }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} item(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
