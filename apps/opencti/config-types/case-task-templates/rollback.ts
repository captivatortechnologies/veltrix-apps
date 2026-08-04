import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { DELETE_TASK_TEMPLATE_MUTATION, PATCH_TASK_TEMPLATE_MUTATION, buildRestorePatch, type OpenctiTaskTemplate } from './_shared'

/**
 * Undo a case-task-templates deploy from rollbackData.previous (written by
 * deploy()): for each entry with a prior body, taskTemplateFieldPatch(id, input)
 * restores it; a newly created template (prior body null) is deleted via
 * taskTemplateDelete(id). Applied over the OpenCTI GraphQL API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; templateId: string | null; template: OpenctiTaskTemplate | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for case-task-template rollback' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { templateId, template } of previous) {
      if (templateId == null) {
        // A created template whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (template) {
        const input = buildRestorePatch(template)
        if (input.length > 0) {
          await graphql(base, headers, PATCH_TASK_TEMPLATE_MUTATION, { id: templateId, input })
        }
        restored++
      } else {
        await graphql(base, headers, DELETE_TASK_TEMPLATE_MUTATION, { id: templateId })
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back case task templates: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
