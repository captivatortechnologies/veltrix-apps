import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { DELETE_CASE_TEMPLATE_MUTATION, PATCH_CASE_TEMPLATE_MUTATION, buildRestorePatch, type OpenctiCaseTemplate } from './_shared'

/**
 * Undo a case-templates deploy from rollbackData.previous (written by deploy()):
 * for each entry with a prior body, caseTemplateFieldPatch(id, input) restores
 * it (including its prior task ids); a newly created case template (prior body
 * null) is deleted via caseTemplateDelete(id). Applied over the OpenCTI GraphQL
 * API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; caseTemplateId: string | null; caseTemplate: OpenctiCaseTemplate | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for case-template rollback' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { caseTemplateId, caseTemplate } of previous) {
      if (caseTemplateId == null) {
        // A created case template whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (caseTemplate) {
        await graphql(base, headers, PATCH_CASE_TEMPLATE_MUTATION, { id: caseTemplateId, input: buildRestorePatch(caseTemplate) })
        restored++
      } else {
        await graphql(base, headers, DELETE_CASE_TEMPLATE_MUTATION, { id: caseTemplateId })
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
