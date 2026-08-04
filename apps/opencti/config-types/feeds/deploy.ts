import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import { ADD_FEED_MUTATION, EDIT_FEED_MUTATION, LIST_FEEDS_QUERY, buildFeedInput, feedsFromList, findFeed, type OpenctiFeed } from './_shared'

/**
 * Deploy OpenCTI feeds over the GraphQL API:
 *   read (rollback + preserve): feeds → find the live feed by name
 *   create: feedAdd(input: FeedAddInput!)
 *   update: feedEdit(id, input: FeedAddInput!) — a WHOLE-OBJECT REPLACE, not a
 *     patch list (unlike every other type in this app). The same
 *     `buildFeedInput` builds the input for both branches.
 *
 * The `name` is the stable identity used to upsert. rollbackData records, per
 * feed, the prior COMPLETE node (null when it did not exist) AND its id — so
 * rollback can restore the exact prior object (feedEdit needs the full state,
 * not a diff) or delete the one we created.
 */
async function listFeeds(base: string, headers: Record<string, string>): Promise<OpenctiFeed[]> {
  try {
    return feedsFromList(await graphql<unknown>(base, headers, LIST_FEEDS_QUERY))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for feed deployment' }
  }

  const base = buildOpenctiUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; feedId: string | null; feed: OpenctiFeed | null }> = []
  const applied: string[] = []

  try {
    const live = await listFeeds(base, headers)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const existing = findFeed(live, name)
      const input = buildFeedInput(item.fields, existing)

      if (existing && existing.id != null) {
        await graphql(base, headers, EDIT_FEED_MUTATION, { id: existing.id, input })
        previous.push({ name, feedId: String(existing.id), feed: existing })
      } else {
        const created = await graphql<{ feedAdd?: OpenctiFeed }>(base, headers, ADD_FEED_MUTATION, { input })
        const newId = created?.feedAdd?.id ?? null
        previous.push({ name, feedId: newId ? String(newId) : null, feed: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} feed(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Feed deploy failed after ${applied.length} feed(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
