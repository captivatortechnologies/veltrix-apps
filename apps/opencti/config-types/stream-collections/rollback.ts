import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { DELETE_STREAM_COLLECTION_MUTATION, PATCH_STREAM_COLLECTION_MUTATION, buildRestorePatch, type OpenctiStreamCollection } from './_shared'

/**
 * Undo a stream-collections deploy from rollbackData.previous (written by
 * deploy()): for each entry with a prior body, streamCollectionEdit(id) {
 * fieldPatch(input) } restores it; a newly created collection (prior body
 * null) is deleted via streamCollectionEdit(id) { delete }. Applied over the
 * OpenCTI GraphQL API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; collectionId: string | null; collection: OpenctiStreamCollection | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for stream-collection rollback' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { collectionId, collection } of previous) {
      if (collectionId == null) {
        // A created collection whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (collection) {
        const input = buildRestorePatch(collection)
        if (input.length > 0) {
          await graphql(base, headers, PATCH_STREAM_COLLECTION_MUTATION, { id: collectionId, input })
        }
        restored++
      } else {
        await graphql(base, headers, DELETE_STREAM_COLLECTION_MUTATION, { id: collectionId })
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back stream collections: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
