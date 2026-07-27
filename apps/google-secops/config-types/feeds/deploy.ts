import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildSecOpsClient,
  parseJson,
  readSecOpsSettings,
  resolveSecOpsCredential,
  secopsErrorMessage,
  MISSING_CREDENTIAL_MESSAGE,
  type SecOpsClient,
} from '../../lib/googlesecops'
import { extractFeedSpecs, type FeedSpec, type LiveFeed } from './validate'

// A feed's id is a server-assigned UUID, so identity is the displayName we own.
// Per-source secrets inside `details` are write-only: they are sent on every
// create/update (the canvas holds the real values) but never read back, so they
// are excluded from drift and NOT restored on rollback (only the name is).
export interface RollbackEntry {
  itemId?: string
  displayName: string
  /** Whether the feed existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  /** The server-assigned feedId, kept so rollback/reconcile can target it after a rename. */
  feedId?: string
  priorDisplayName?: string
}

const enc = encodeURIComponent

/** The server-assigned feedId at the tail of a `{parent}/feeds/{feedId}` name. */
export function feedIdOf(name: string): string {
  return name.split('/').pop() ?? ''
}

export function feedBody(spec: FeedSpec): Record<string, unknown> {
  return { displayName: spec.displayName, details: spec.details ?? {} }
}

/** List every feed under the parent, following pagination. */
export async function listFeeds(client: SecOpsClient, parent: string): Promise<{ ok: boolean; feeds: LiveFeed[]; error?: string }> {
  const feeds: LiveFeed[] = []
  let pageToken = ''
  do {
    const query = pageToken ? `?pageSize=1000&pageToken=${enc(pageToken)}` : '?pageSize=1000'
    const res = await client.request('GET', `${parent}/feeds${query}`)
    if (!res.ok) return { ok: false, feeds, error: secopsErrorMessage(res) }
    const parsed = parseJson<{ feeds?: LiveFeed[]; nextPageToken?: string }>(res.body)
    if (parsed?.feeds) feeds.push(...parsed.feeds)
    pageToken = parsed?.nextPageToken ?? ''
  } while (pageToken)
  return { ok: true, feeds }
}

async function loadPriorEntries(ctx: DeployContext): Promise<RollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: RollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as RollbackEntry[]) : []
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const specs = extractFeedSpecs(ctx.canvas).filter((s) => s.displayName && s.details)
  const prior = await loadPriorEntries(ctx)

  // Identity is server-assigned, so resolve each spec by listing: match by the
  // feedId stored last deploy (rename-safe), else by the current displayName.
  const listed = await listFeeds(client, parent)
  if (!listed.ok) return { success: false, message: `Could not list Google SecOps feeds: ${listed.error}` }
  const byFeedId = new Map(listed.feeds.map((fd) => [feedIdOf(fd.name ?? ''), fd]))
  const byDisplayName = new Map(listed.feeds.map((fd) => [fd.displayName ?? '', fd]))
  const priorByItem = new Map(prior.filter((p) => p.itemId).map((p) => [p.itemId!, p]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItem.get(spec.itemId) : undefined
    const live = (priorEntry?.feedId ? byFeedId.get(priorEntry.feedId) : undefined) ?? byDisplayName.get(spec.displayName)

    if (live) {
      const feedId = feedIdOf(live.name ?? '')
      const resp = await client.request('PATCH', `${parent}/feeds/${enc(feedId)}?updateMask=displayName,details`, feedBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.displayName}: ${secopsErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, displayName: spec.displayName, existed: true, feedId, priorDisplayName: live.displayName ?? spec.displayName })
    } else {
      const resp = await client.request('POST', `${parent}/feeds`, feedBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.displayName}: ${secopsErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveFeed>(resp.body)
      entries.push({ itemId: spec.itemId, displayName: spec.displayName, existed: false, feedId: feedIdOf(created?.name ?? '') })
    }
  }

  // Reconcile: delete feeds THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.displayName.toLowerCase()))
  const declaredItems = new Set(specs.map((s) => s.itemId).filter(Boolean))
  for (const p of prior) {
    if (p.existed || !p.feedId) continue
    if ((p.itemId && declaredItems.has(p.itemId)) || declaredNames.has(p.displayName.toLowerCase())) continue
    const del = await client.request('DELETE', `${parent}/feeds/${enc(p.feedId)}`)
    if (!del.ok && del.status !== 404) failures.push(`delete ${p.displayName}: ${secopsErrorMessage(del)}`)
  }

  if (failures.length) {
    return { success: false, message: `Some feeds failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} feed(s)`, rollbackData: { entries } }
}
