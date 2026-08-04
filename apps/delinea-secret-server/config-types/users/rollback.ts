import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient, secretServerErrorMessage } from '../../lib/secretServerApi'
import { buildUserRestoreBody } from './_shared'
import type { UserRollbackEntry } from './deploy'

/**
 * Undo a users deploy from rollbackData.previous (written by deploy()): for
 * each user this app updated, PUT /users/{id} with the exact prior full
 * object snapshotted before deploy. This app never creates users, so there is
 * never a "leave in place" case here — every entry was an update. Applied
 * over the Secret Server REST API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { previous?: UserRollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildSecretServerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  try {
    for (const entry of previous) {
      if (!entry.prior || entry.userId === null) continue
      const res = await client.request('PUT', `/users/${entry.userId}`, { body: buildUserRestoreBody(entry.prior) })
      if (!res.ok) throw new Error(`Failed to restore user "${entry.username}": ${secretServerErrorMessage(res)}`)
      restored++
    }
    return { success: true, message: `Rolled back ${restored} user(s).` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
