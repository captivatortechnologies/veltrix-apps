import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildOpenctiUrl, buildAuthHeader, graphql } from '../../lib/openctiApi'
import {
  ADD_FEED_MUTATION,
  LIST_FEEDS_QUERY,
  PATCH_FEED_MUTATION,
  buildFeedInput,
  buildFeedPatch,
  feedsFromList,
  findFeed,
  type OpenctiFeed,
} from './_shared'

/**
 * Deploy OpenCTI TAXII2 ingestion feeds over the GraphQL API:
 *   read (rollback): ingestionTaxiis        → find the live feed by name
 *   create:          ingestionTaxiiAdd(input) with { name, uri, collection, version, authentication_type, ... }
 *   update:          ingestionTaxiiEdit(id, input) with [EditInput] (feed exists)
 *
 * The `name` is the stable identity used to upsert. rollbackData records, per feed,
 * the prior feed node (null when it did not exist) AND the feed id — so rollback can
 * restore the prior body or delete the one we created. The secret
 * `authentication_value` is never read back, so it is not captured for restore.
 *
 * NOTE: ingestionTaxiiAdd returns the created feed (with its new id). Verify the
 * operation names + field shapes against a live OpenCTI instance.
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
    return { success: false, message: 'Missing credential for ingestion-feed deployment' }
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

      if (existing && existing.id != null) {
        await graphql(base, headers, PATCH_FEED_MUTATION, { id: existing.id, input: buildFeedPatch(item.fields) })
        previous.push({ name, feedId: String(existing.id), feed: existing })
      } else {
        const created = await graphql<{ ingestionTaxiiAdd?: OpenctiFeed }>(base, headers, ADD_FEED_MUTATION, {
          input: buildFeedInput(item.fields),
        })
        const newId = created?.ingestionTaxiiAdd?.id ?? null
        previous.push({ name, feedId: newId ? String(newId) : null, feed: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} ingestion feed(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Ingestion-feed deploy failed after ${applied.length} feed(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
