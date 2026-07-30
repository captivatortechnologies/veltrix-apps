import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, sendJson } from '../../lib/mispApi'
import type { MispSharingGroup } from './_shared'

/**
 * Undo a sharing-groups deploy from rollbackData.previous (written by deploy()):
 * for each entry with a prior body, POST /sharing_groups/edit/<id> to restore it;
 * a newly created group (prior body null) is left in place — MISP has no simple
 * sharing-group delete over this seam. Applied over the MISP REST API (443).
 * Verify /sharing_groups/edit/<id> against a live MISP 2.4 instance.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; groupId: number | string | null; group: MispSharingGroup | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for sharing group rollback' }
  }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let left = 0
  try {
    for (const { groupId, group } of previous) {
      if (groupId == null || !group) {
        // A newly created group (or one whose id we never learned) — leave it in place.
        left++
        continue
      }
      await sendJson('POST', `${base}/sharing_groups/edit/${encodeURIComponent(String(groupId))}`, headers, { SharingGroup: group })
      restored++
    }
    return { success: true, message: `Rolled back sharing groups: ${restored} restored${left ? `, ${left} left in place` : ''}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
