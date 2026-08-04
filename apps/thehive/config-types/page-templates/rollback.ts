import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildThehiveUrl, buildAuthHeader, sendJson, PAGE_TEMPLATE_PATHS_V5 } from '../../lib/thehiveApi'
import { toPageTemplateUpdate, type PageTemplate } from './_shared'

/**
 * Undo a page-templates deploy from rollbackData.previous (written by deploy()):
 * for each entry, PATCH /api/v1/pageTemplate/<id> with the prior template's
 * content/category/order (restore), or — when the template was newly created
 * (prior body null) — DELETE /api/v1/pageTemplate/<id> to remove it. deploy()
 * already refuses to run against a non-v5 target, so if rollbackData.previous is
 * non-empty this is always a v5 target — no separate version gate needed here.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ title: string; templateId: string | null; template: PageTemplate | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for page template rollback' }
  }

  const base = buildThehiveUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { templateId, template } of previous) {
      if (!templateId) {
        skipped++
        continue
      }
      const path = `${base}${PAGE_TEMPLATE_PATHS_V5.pageTemplateById(templateId)}`
      if (template) {
        await sendJson('PATCH', path, headers, toPageTemplateUpdate(template))
        restored++
      } else {
        await sendJson('DELETE', path, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back page templates: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
