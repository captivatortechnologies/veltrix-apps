import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, sendJson } from '../../lib/sumoLogicApi'
import { buildUserUpdateBody, type SumoUser } from './_shared'

/**
 * Undo a users deploy from rollbackData.previous (written by deploy()): for
 * each entry, PUT /users/<id> with the prior mutable-subset body (restore), or
 * — when the user was newly created (prior body null) — DELETE /users/<id> to
 * remove them. Applied over the Sumo Logic Management API.
 *
 * Deleting a user does not pass the optional `transferTo` query parameter, so
 * content they own is handled by Sumo Logic's default reassignment behavior
 * rather than a deliberately chosen recipient — acceptable for a newly
 * created (and therefore content-empty) user, which is the only case this
 * ever deletes.
 *
 * API: https://help.sumologic.com/docs/api/user-management/
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ email: string; userId: string | null; user: SumoUser | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for user rollback' }
  }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { userId, user } of previous) {
      if (userId == null) {
        // A created user whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      const path = `${base}/users/${encodeURIComponent(userId)}`
      if (user) {
        await sendJson('PUT', path, headers, buildUserUpdateBody(user))
        restored++
      } else {
        await sendJson('DELETE', path, headers)
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
