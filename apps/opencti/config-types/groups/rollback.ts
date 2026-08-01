import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { DELETE_GROUP_MUTATION, PATCH_GROUP_MUTATION, buildRestorePatch, type OpenctiGroup } from './_shared'

/**
 * Undo a groups deploy from rollbackData.previous (written by deploy()): for each
 * entry with a prior body, groupEdit(id) { fieldPatch(input) } restores it; a newly
 * created group (prior body null) is deleted via groupDelete(id). Applied over the
 * OpenCTI GraphQL API. Verify the operation names against a live OpenCTI instance.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; groupId: string | null; group: OpenctiGroup | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for group rollback' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { groupId, group } of previous) {
      if (groupId == null) {
        // A created group whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (group) {
        const input = buildRestorePatch(group)
        if (input.length > 0) {
          await graphql(base, headers, PATCH_GROUP_MUTATION, { id: groupId, input })
        }
        restored++
      } else {
        await graphql(base, headers, DELETE_GROUP_MUTATION, { id: groupId })
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back groups: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
