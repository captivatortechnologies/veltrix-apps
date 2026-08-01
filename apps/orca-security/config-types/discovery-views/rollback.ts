import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOrcaClient } from '../../lib/orcaApi'
import type { DiscoveryViewRollbackData } from './_shared'

/**
 * Undo a discovery-views deploy from rollbackData.previous (written by deploy()):
 *   - a view we CREATED (existed=false) -> DELETE /api/user_preferences/{id}
 *   - a view we UPDATED (existed=true)  -> PUT    /api/user_preferences/{id}
 *                                          with the prior body (restore)
 * An entry with no id (a create whose id we never learned) is skipped.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const data = (ctx.rollbackData ?? {}) as DiscoveryViewRollbackData
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  const built = buildOrcaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const entry of previous) {
      if (!entry.serverId) {
        skipped++
        continue
      }
      const path = `/api/user_preferences/${encodeURIComponent(entry.serverId)}`
      if (entry.existed && entry.prior) {
        const res = await client.request('PUT', path, entry.prior)
        if (res.error) throw new Error(`restore discovery view "${entry.name}" failed: ${res.error}`)
        restored++
      } else if (!entry.existed) {
        const res = await client.request('DELETE', path)
        // A view already gone (404) is an acceptable rollback outcome.
        if (res.error && res.status !== 404) throw new Error(`delete discovery view "${entry.name}" failed: ${res.error}`)
        deleted++
      } else {
        skipped++
      }
    }
    return {
      success: true,
      message: `Rolled back discovery views: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
