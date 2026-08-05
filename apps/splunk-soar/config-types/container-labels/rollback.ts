import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildSoarUrl, buildAuthHeader, sendJson } from '../../lib/soarApi'

/**
 * Undo a container labels deploy: removes only the labels THIS deploy newly
 * added (rollbackData.added), via POST /rest/system_settings/events
 * { remove_label: true, label_name }. Labels that already existed before this
 * deploy are never touched. Removing a label does not affect containers that
 * already carry it — SOAR simply drops it from the picker.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity } = ctx
  const data = (ctx.rollbackData ?? {}) as { added?: string[] }
  const added = data.added ?? []
  if (added.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) return { success: false, message: 'Missing credential for container label rollback' }

  const base = buildSoarUrl(component, connectivity)
  const headers = buildAuthHeader(credential)

  let removed = 0
  try {
    for (const name of added) {
      await sendJson('POST', `${base}/rest/system_settings/events`, headers, { remove_label: true, label_name: name })
      removed++
    }
    return { success: true, message: `Rolled back container labels: ${removed} removed.` }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
