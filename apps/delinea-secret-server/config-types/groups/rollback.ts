import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient, secretServerErrorMessage } from '../../lib/secretServerApi'
import { buildGroupRestoreBody } from './_shared'
import type { GroupRollbackEntry } from './deploy'

/**
 * Undo a groups deploy from rollbackData.previous (written by deploy()): for each
 * group that already existed, PUT /groups/{id} to restore its prior body; a newly
 * created group (existed=false) is left in place — this app does not delete
 * groups. Applied over the Secret Server REST API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as { previous?: GroupRollbackEntry[] }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildSecretServerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  let restored = 0
  let left = 0
  try {
    for (const entry of previous) {
      if (!entry.existed || !entry.prior || entry.groupId === null) {
        // A newly created group (or one whose id we never learned) — leave it in place.
        left++
        continue
      }
      const res = await client.request('PUT', `/groups/${entry.groupId}`, { body: buildGroupRestoreBody(entry.prior) })
      if (!res.ok) throw new Error(`Failed to restore group "${entry.groupName}": ${secretServerErrorMessage(res)}`)
      restored++
    }
    return { success: true, message: `Rolled back groups: ${restored} restored${left ? `, ${left} left in place` : ''}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
