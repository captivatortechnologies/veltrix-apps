import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildThehiveUrl, buildAuthHeader, sendJson, PRIMARY } from '../../lib/thehiveApi'
import { toUserUpdate, type HiveUser } from './_shared'

/**
 * Undo a users deploy from rollbackData.previous (written by deploy()): for each
 * entry, PATCH /api/v1/user/<id> with the prior user's mutable subset (restore),
 * or — when the user was newly created (prior body null) — DELETE
 * /api/v1/user/<id>/force to remove it. Verify paths against a live TheHive
 * (see README, v4 vs v5).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ login: string; userIdValue: string | null; user: HiveUser | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for user rollback' }
  }

  const base = buildThehiveUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { userIdValue, user } of previous) {
      if (!userIdValue) {
        // A created user whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (user) {
        await sendJson('PATCH', `${base}${PRIMARY.userById(userIdValue)}`, headers, toUserUpdate(user))
        restored++
      } else {
        await sendJson('DELETE', `${base}${PRIMARY.userDelete(userIdValue)}`, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back users: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
