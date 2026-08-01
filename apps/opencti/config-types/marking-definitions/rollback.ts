import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { DELETE_MARKING_MUTATION, PATCH_MARKING_MUTATION, buildRestorePatch, type OpenctiMarking } from './_shared'

/**
 * Undo a marking-definitions deploy from rollbackData.previous (written by deploy()):
 * for each entry with a prior body, markingDefinitionFieldPatch(id, input) restores
 * it; a newly created marking (prior body null) is deleted via
 * markingDefinitionDelete(id). Applied over the OpenCTI GraphQL API. Verify the
 * operation names against a live OpenCTI instance.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ definition: string; markingId: string | null; marking: OpenctiMarking | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for marking-definition rollback' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { markingId, marking } of previous) {
      if (markingId == null) {
        // A created marking whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (marking) {
        const input = buildRestorePatch(marking)
        if (input.length > 0) {
          await graphql(base, headers, PATCH_MARKING_MUTATION, { id: markingId, input })
        }
        restored++
      } else {
        await graphql(base, headers, DELETE_MARKING_MUTATION, { id: markingId })
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back marking definitions: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
