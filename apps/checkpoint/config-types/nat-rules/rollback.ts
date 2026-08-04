import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildCheckpointClient, checkpointErrorMessage, isNotFoundError } from '../../lib/checkpointApi'
import type { RollbackEntry } from './deploy'

function identifyRule(entry: RollbackEntry): Record<string, unknown> {
  const params: Record<string, unknown> = { package: entry.package }
  if (entry.uid) params.uid = entry.uid
  else params.name = entry.name
  return params
}

/**
 * Roll back Check Point NAT rules using the state captured during deploy,
 * inside one session:
 *   - rules that were CREATED (existed: false) are removed (delete-nat-rule)
 *   - rules that were UPDATED (existed: true) are restored to their prior
 *     FIELD values (set-nat-rule) — position is intentionally NOT restored,
 *     for the same reason as access-rules (see README).
 * Applied in reverse deploy order. Publishes on success; discards the whole
 * session on any error.
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
        const res = await client.call('set-nat-rule', { ...identifyRule(entry), ...entry.prior })
        if (!res.ok) throw new Error(`Failed to restore NAT rule "${entry.name}": ${checkpointErrorMessage(res)}`)
        restored++
      } else if (!entry.existed) {
        const res = await client.call('delete-nat-rule', identifyRule(entry))
        if (!res.ok && !isNotFoundError(res)) {
          throw new Error(`Failed to delete NAT rule "${entry.name}": ${checkpointErrorMessage(res)}`)
        }
        removed++
      }
    }

    const publish = await client.publish()
    if (!publish.ok) throw new Error(`publish failed: ${checkpointErrorMessage(publish)}`)

    await client.logout()
    return {
      success: true,
      message: `Rolled back ${previousState.length} Check Point NAT rule(s): ${removed} removed, ${restored} restored.`,
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
