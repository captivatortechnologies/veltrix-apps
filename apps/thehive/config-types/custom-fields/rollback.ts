import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildThehiveUrl, buildAuthHeader, sendJson, PRIMARY } from '../../lib/thehiveApi'
import { toUpdateBody, type CustomField } from './_shared'

/**
 * Undo a custom-fields deploy from rollbackData.previous (written by deploy()):
 * for each entry, PATCH /api/v1/customField/<id> with the prior field's updatable
 * subset (restore), or — when the field was newly created (prior body null) —
 * DELETE /api/v1/customField/<id> to remove it. Verify paths against a live
 * TheHive (see README, v4 vs v5).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; fieldId: string | null; field: CustomField | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for custom field rollback' }
  }

  const base = buildThehiveUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { fieldId, field } of previous) {
      if (!fieldId) {
        skipped++
        continue
      }
      const path = `${base}${PRIMARY.customFieldById(fieldId)}`
      if (field) {
        await sendJson('PATCH', path, headers, toUpdateBody(field))
        restored++
      } else {
        await sendJson('DELETE', path, headers)
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
