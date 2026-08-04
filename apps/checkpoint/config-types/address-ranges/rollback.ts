import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCheckpointClient, checkpointErrorMessage, isNotFoundError } from '../../lib/checkpointApi'
import type { RollbackEntry } from './deploy'

/**
 * Roll back Check Point address ranges using the state captured during
 * deploy, inside one session: created ranges are removed
 * (delete-address-range); updated ranges are restored to their prior fields
 * (set-address-range). Applied in reverse deploy order. Publishes on
 * success; discards the whole session on any error.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildCheckpointClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previousState = (ctx.rollbackData as { entries?: RollbackEntry[] } | undefined)?.entries
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const login = await client.login()
  if (login.error) return { success: false, message: login.error }

  let restored = 0
  let removed = 0

  try {
    for (const entry of [...previousState].reverse()) {
      if (entry.existed && entry.prior) {
        const res = await client.call('set-address-range', entry.prior)
        if (!res.ok) throw new Error(`Failed to restore address range "${entry.name}": ${checkpointErrorMessage(res)}`)
        restored++
      } else if (!entry.existed) {
        const res = await client.call('delete-address-range', { name: entry.name })
        if (!res.ok && !isNotFoundError(res)) {
          throw new Error(`Failed to delete address range "${entry.name}": ${checkpointErrorMessage(res)}`)
        }
        removed++
      }
    }

    const publish = await client.publish()
    if (!publish.ok) throw new Error(`publish failed: ${checkpointErrorMessage(publish)}`)

    await client.logout()
    return {
      success: true,
      message: `Rolled back ${previousState.length} Check Point address range(s): ${removed} removed, ${restored} restored.`,
    }
  } catch (error) {
    await client.discard()
    await client.logout()
    return {
      success: false,
      message: `Rollback failed — session changes were discarded: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
