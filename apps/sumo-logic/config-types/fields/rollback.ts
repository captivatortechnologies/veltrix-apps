import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, sendJson } from '../../lib/sumoLogicApi'
import { isFieldEnabled, type CustomField } from './_shared'

/**
 * Undo a custom-fields deploy from rollbackData.previous (written by deploy()):
 * for each entry, restore the prior enabled state (PUT /fields/<id>/enable or
 * DELETE /fields/<id>/disable), or — when the field was newly created (prior body
 * null) — DELETE /fields/<id> to remove it. Applied over the Sumo Logic
 * Management API.
 *
 * API: https://www.sumologic.com/help/docs/api/field-management/
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ fieldName: string; fieldId: string | null; field: CustomField | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for custom field rollback' }
  }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { fieldId, field } of previous) {
      if (fieldId == null) {
        // A created field whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      const id = encodeURIComponent(fieldId)
      if (field) {
        const enabled = isFieldEnabled(field)
        await sendJson(enabled ? 'PUT' : 'DELETE', `${base}/fields/${id}/${enabled ? 'enable' : 'disable'}`, headers)
        restored++
      } else {
        await sendJson('DELETE', `${base}/fields/${id}`, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back custom fields: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
