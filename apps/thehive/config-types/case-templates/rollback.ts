import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildThehiveUrl, buildAuthHeader, sendJson, PRIMARY } from '../../lib/thehiveApi'
import type { CaseTemplate } from './_shared'

/**
 * Undo a case-templates deploy from rollbackData.previous (written by deploy()):
 * for each entry, PATCH /api/v1/caseTemplate/<id> with the prior template body
 * (restore), or — when the template was newly created (prior body null) —
 * DELETE /api/v1/caseTemplate/<id> to remove it. Applied over the TheHive REST
 * API. Verify paths against a live TheHive (see README, v4 vs v5).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; templateId: string | null; template: CaseTemplate | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for case template rollback' }
  }

  const base = buildThehiveUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { templateId, template } of previous) {
      if (!templateId) {
        // A created template whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      const path = `${base}${PRIMARY.caseTemplateById(templateId)}`
      if (template) {
        await sendJson('PATCH', path, headers, template)
        restored++
      } else {
        await sendJson('DELETE', path, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back case templates: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
