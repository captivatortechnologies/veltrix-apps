import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { DELETE_FEED_MUTATION, PATCH_FEED_MUTATION, buildRestorePatch, type OpenctiFeed } from './_shared'

/**
 * Undo an ingestion-feeds deploy from rollbackData.previous (written by deploy()):
 * for each entry with a prior body, ingestionTaxiiEdit(id, input) restores it; a
 * newly created feed (prior body null) is deleted via ingestionTaxiiDelete(id).
 * Applied over the OpenCTI GraphQL API. The secret authentication_value is not read
 * back, so it is not restored. Verify the operation names against a live OpenCTI
 * instance.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; feedId: string | null; feed: OpenctiFeed | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for ingestion-feed rollback' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { feedId, feed } of previous) {
      if (feedId == null) {
        // A created feed whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (feed) {
        const input = buildRestorePatch(feed)
        if (input.length > 0) {
          await graphql(base, headers, PATCH_FEED_MUTATION, { id: feedId, input })
        }
        restored++
      } else {
        await graphql(base, headers, DELETE_FEED_MUTATION, { id: feedId })
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back ingestion feeds: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
