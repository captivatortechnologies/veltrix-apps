import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { DELETE_FEED_MUTATION, EDIT_FEED_MUTATION, buildRestoreInput, type OpenctiFeed } from './_shared'

/**
 * Undo a feeds deploy from rollbackData.previous (written by deploy()): for
 * each entry with a prior body, feedEdit(id, input) restores the COMPLETE
 * prior object (feedEdit is a whole-object replace, not a patch — there is no
 * partial restore); a newly created feed (prior body null) is deleted via
 * feedDelete(id). Applied over the OpenCTI GraphQL API.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; feedId: string | null; feed: OpenctiFeed | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for feed rollback' }
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
        await graphql(base, headers, EDIT_FEED_MUTATION, { id: feedId, input: buildRestoreInput(feed) })
        restored++
      } else {
        await graphql(base, headers, DELETE_FEED_MUTATION, { id: feedId })
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back feeds: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
