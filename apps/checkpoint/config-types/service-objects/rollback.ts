import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCheckpointClient, checkpointErrorMessage, isNotFoundError } from '../../lib/checkpointApi'
import { SERVICE_COMMANDS } from './validate'
import type { RollbackEntry } from './deploy'

/**
 * Roll back Check Point service objects using the state captured during
 * deploy, inside one session:
 *   - services that were CREATED (existed: false) are removed (delete-service-{tcp,udp})
 *   - services that were UPDATED (existed: true) are restored to their prior
 *     managed body (set-service-{tcp,udp})
 * Applied in reverse deploy order, using each entry's own protocol. Publishes
 * on success; discards the whole session on any error.
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
      const commands = SERVICE_COMMANDS[entry.protocol]
      if (entry.existed && entry.prior) {
        const res = await client.call(commands.set, entry.prior)
        if (!res.ok) throw new Error(`Failed to restore service "${entry.name}": ${checkpointErrorMessage(res)}`)
        restored++
      } else if (!entry.existed) {
        const res = await client.call(commands.delete, { name: entry.name })
        if (!res.ok && !isNotFoundError(res)) {
          throw new Error(`Failed to delete service "${entry.name}": ${checkpointErrorMessage(res)}`)
        }
        removed++
      }
    }

    const publish = await client.publish()
    if (!publish.ok) throw new Error(`publish failed: ${checkpointErrorMessage(publish)}`)

    await client.logout()
    return {
      success: true,
      message: `Rolled back ${previousState.length} Check Point service object(s): ${removed} removed, ${restored} restored.`,
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
