import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildThehiveUrl, buildAuthHeader, sendJson, PRIMARY } from '../../lib/thehiveApi'
import { toProfileUpdate, type Profile } from './_shared'

/**
 * Undo a profiles deploy from rollbackData.previous (written by deploy()): for
 * each entry, PATCH /api/v1/profile/<id> with the prior profile's permission set
 * (restore), or — when the profile was newly created (prior body null) — DELETE
 * /api/v1/profile/<id> to remove it. Verify paths against a live TheHive
 * (see README, v4 vs v5).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; profileId: string | null; profile: Profile | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for profile rollback' }
  }

  const base = buildThehiveUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { profileId: pid, profile } of previous) {
      if (!pid) {
        skipped++
        continue
      }
      if (profile) {
        await sendJson('PATCH', `${base}${PRIMARY.profileById(pid)}`, headers, toProfileUpdate(profile))
        restored++
      } else {
        await sendJson('DELETE', `${base}${PRIMARY.profileDelete(pid)}`, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back profiles: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
