import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { DELETE_TAXII_COLLECTION_MUTATION, PATCH_TAXII_COLLECTION_MUTATION, buildRestorePatch, type OpenctiTaxiiCollection } from './_shared'

/**
 * Undo a taxii-collections deploy from rollbackData.previous (written by
 * deploy()): for each entry with a prior body, taxiiCollectionEdit(id) {
 * fieldPatch(input) } restores it; a newly created collection (prior body
 * null) is deleted via taxiiCollectionEdit(id) { delete }. Applied over the
 * OpenCTI GraphQL API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; collectionId: string | null; collection: OpenctiTaxiiCollection | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for taxii-collection rollback' }
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
          await graphql(base, headers, PATCH_TAXII_COLLECTION_MUTATION, { id: collectionId, input })
        }
        restored++
      } else {
        await graphql(base, headers, DELETE_TAXII_COLLECTION_MUTATION, { id: collectionId })
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back TAXII collections: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
