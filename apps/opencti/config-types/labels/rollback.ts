import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { DELETE_LABEL_MUTATION, PATCH_LABEL_MUTATION, buildRestorePatch, type OpenctiLabel } from './_shared'

/**
 * Undo a labels deploy from rollbackData.previous (written by deploy()): for each
 * entry with a prior body, labelFieldPatch(id, input) restores it; a newly created
 * label (prior body null) is deleted via labelDelete(id). Applied over the OpenCTI
 * GraphQL API. Verify the operation names against a live OpenCTI instance.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ value: string; labelId: string | null; label: OpenctiLabel | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for label rollback' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { labelId, label } of previous) {
      if (labelId == null) {
        // A created label whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (label) {
        const input = buildRestorePatch(label)
        if (input.length > 0) {
          await graphql(base, headers, PATCH_LABEL_MUTATION, { id: labelId, input })
        }
        restored++
      } else {
        await graphql(base, headers, DELETE_LABEL_MUTATION, { id: labelId })
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back labels: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
