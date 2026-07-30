import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, getJson, sendJson } from '../../lib/mispApi'
import { buildFeedFields, feedsFromList, findFeed, type MispFeed } from './_shared'

/**
 * Deploy MISP threat feeds over the REST API (443):
 *   read (rollback): GET  /feeds                 → find the live feed by url/name
 *   create:          POST /feeds/add             with { Feed: {...} }
 *   update:          POST /feeds/edit/<id>        with { Feed: {...} } (feed exists)
 *
 * The feed URL is the stable identity used to upsert. rollbackData records, per
 * feed, the prior feed body (null when it did not exist) AND the feed id — so
 * rollback can restore the prior body or disable the one we created.
 *
 * NOTE: MISP 2.4 returns the created feed (with its new id) from /feeds/add inside
 * a { Feed: {...} } envelope. Verify against a live MISP 2.4 instance.
 */
interface FeedMutationResponse {
  Feed?: MispFeed
}

/** Read every live feed (best-effort) for identity matching + rollback snapshots. */
async function listFeeds(base: string, headers: Record<string, string>): Promise<MispFeed[]> {
  try {
    return feedsFromList(await getJson<unknown>(`${base}/feeds`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for threat feed deployment' }
  }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ name: string; url: string; feedId: number | string | null; feed: MispFeed | null }> = []
  const applied: string[] = []

  try {
    const live = await listFeeds(base, headers)

    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      const url = String(item.fields.url ?? '').trim()
      if (!url && !name) continue

      const existing = findFeed(live, url, name)
      const body = { Feed: buildFeedFields(item.fields) }

      if (existing && existing.id != null) {
        await sendJson('POST', `${base}/feeds/edit/${encodeURIComponent(String(existing.id))}`, headers, body)
        previous.push({ name, url, feedId: existing.id, feed: existing })
      } else {
        const created = await sendJson<FeedMutationResponse>('POST', `${base}/feeds/add`, headers, body)
        const newId = created?.Feed?.id ?? null
        previous.push({ name, url, feedId: newId, feed: null })
      }
      applied.push(name || url)
    }

    return {
      success: true,
      message: `Applied ${applied.length} threat feed(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Threat feed deploy failed after ${applied.length} feed(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
