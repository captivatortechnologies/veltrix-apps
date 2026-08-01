import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildTaniumBaseUrl, resolveTaniumSession, sendJson } from '../../lib/taniumApi'
import { buildGroupBody, type TaniumGroup } from './_shared'

/**
 * Undo a computer-groups deploy from rollbackData.previous (written by deploy()):
 *   - a group that existed before → PUT /api/v2/groups/{id} to restore its prior body.
 *   - a group this deploy created (prior body null) → DELETE /api/v2/groups/{id}.
 *   - an entry whose id we never learned → left in place.
 * Applied over the Tanium REST v2 API (443). Verify PUT/DELETE /api/v2/groups/{id}
 * against a live Tanium.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; groupId: number | string | null; group: TaniumGroup | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for computer-group rollback' }
  }

  const base = buildTaniumBaseUrl(component, connectivity, connectivityProvider)

  let restored = 0
  let deleted = 0
  let left = 0
  try {
    const session = await resolveTaniumSession(base, credential)
    for (const { groupId, group } of previous) {
      if (groupId == null) {
        left++
        continue
      }
      const path = `${base}/groups/${encodeURIComponent(String(groupId))}`
      if (group) {
        // Restore the prior body (name + filter) onto the existing group.
        await sendJson('PUT', path, session, buildGroupBody({ name: group.name, filterText: group.text, filterJson: group.filters ? JSON.stringify(group.filters) : '' }))
        restored++
      } else {
        // A group this deploy created — remove it.
        await sendJson('DELETE', path, session)
        deleted++
      }
    }
    const parts = [`${restored} restored`, `${deleted} deleted`]
    if (left) parts.push(`${left} left in place`)
    return { success: true, message: `Rolled back computer groups: ${parts.join(', ')}.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
