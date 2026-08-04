import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { DELETE_STATUS_TEMPLATE_MUTATION, PATCH_STATUS_TEMPLATE_MUTATION, buildRestorePatch, type OpenctiStatusTemplate } from './_shared'

/**
 * Undo a status templates deploy from rollbackData.previous (written by
 * deploy()): for each entry with a prior body, statusTemplateFieldPatch(id, input)
 * restores it; a newly created template (prior body null) is deleted via
 * statusTemplateDelete(id). Applied over the OpenCTI GraphQL API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; statusTemplateId: string | null; statusTemplate: OpenctiStatusTemplate | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for status template rollback' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { statusTemplateId, statusTemplate } of previous) {
      if (statusTemplateId == null) {
        // A created status template whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (statusTemplate) {
        const input = buildRestorePatch(statusTemplate)
        if (input.length > 0) {
          await graphql(base, headers, PATCH_STATUS_TEMPLATE_MUTATION, { id: statusTemplateId, input })
        }
        restored++
      } else {
        await graphql(base, headers, DELETE_STATUS_TEMPLATE_MUTATION, { id: statusTemplateId })
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back status templates: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
