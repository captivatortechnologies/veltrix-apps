import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCbClient,
  cbErrorMessage,
  parseJson,
  readCbSettings,
  resolveCbCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type CbClient,
} from '../../lib/carbonblack'
import { extractWatchlistSpecs, FEED_CLASSIFIER_KEY, type WatchlistSpec, type LiveWatchlist } from './validate'

export interface WatchlistPrior {
  name: string
  description: string
  tags_enabled: boolean
  alerts_enabled: boolean
  classifier: { key?: string; value?: string } | null
}

export interface RollbackEntry {
  itemId?: string
  name: string
  existed: boolean
  watchlistId?: string
  /** prior watchlist fields so rollback can restore an updated watchlist. */
  prior?: WatchlistPrior
}

/** The create/update body for a feed-subscription watchlist. */
export function watchlistBody(spec: WatchlistSpec): Record<string, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    tags_enabled: spec.tagsEnabled,
    alerts_enabled: spec.alertsEnabled,
    classifier: { key: FEED_CLASSIFIER_KEY, value: spec.feedId },
  }
}

async function listWatchlists(client: CbClient, watchlistsPath: string): Promise<{ ok: boolean; items: LiveWatchlist[]; err?: string }> {
  const res = await client.get(watchlistsPath)
  if (!res.ok) return { ok: false, items: [], err: cbErrorMessage(res) }
  const parsed = parseJson<{ results?: LiveWatchlist[] } | LiveWatchlist[]>(res.body)
  const items = Array.isArray(parsed) ? parsed : parsed?.results ?? []
  return { ok: true, items }
}

function toPrior(live: LiveWatchlist): WatchlistPrior {
  return {
    name: live.name ?? '',
    description: live.description ?? '',
    tags_enabled: live.tags_enabled ?? false,
    alerts_enabled: live.alerts_enabled ?? false,
    classifier: live.classifier ?? null,
  }
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
  const settings = readCbSettings(ctx.settings)
  const cred = resolveCbCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildCbClient(cred, settings)
  const watchlistsPath = `/threathunter/watchlistmgr/v3/orgs/${cred.orgKey}/watchlists`

  const specs = extractWatchlistSpecs(ctx.canvas).filter((s) => s.name)

  const listed = await listWatchlists(client, watchlistsPath)
  if (!listed.ok) return { success: false, message: `Failed to list watchlists: ${listed.err}` }
  const liveByName = new Map<string, LiveWatchlist>()
  const liveById = new Map<string, LiveWatchlist>()
  for (const w of listed.items) {
    if (w.name) liveByName.set(w.name.toLowerCase(), w)
    if (w.id) liveById.set(w.id, w)
  }

  const prior = await loadPriorEntries(ctx)
  const priorByItem = new Map<string, RollbackEntry>()
  for (const p of prior) if (p.itemId) priorByItem.set(p.itemId, p)

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    // Prefer the prior-stored id (rename-safe) so a renamed watchlist updates in
    // place; otherwise fall back to matching the live set by name.
    const priorEntry = spec.itemId ? priorByItem.get(spec.itemId) : undefined
    const live =
      (priorEntry?.watchlistId && liveById.get(priorEntry.watchlistId)) ||
      liveByName.get(spec.name.toLowerCase()) ||
      null

    if (live?.id) {
      const updated = await client.put(`${watchlistsPath}/${live.id}`, watchlistBody(spec))
      if (!updated.ok) {
        failures.push(`${spec.name}: ${cbErrorMessage(updated)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, name: spec.name, existed: true, watchlistId: live.id, prior: toPrior(live) })
    } else {
      const resp = await client.post(watchlistsPath, watchlistBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.name}: ${cbErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveWatchlist>(resp.body)
      entries.push({ itemId: spec.itemId, name: spec.name, existed: false, watchlistId: created?.id })
    }
  }

  // Reconcile: delete watchlists THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
  const keptIds = new Set(entries.map((e) => e.watchlistId).filter(Boolean) as string[])
  for (const p of prior) {
    if (!p.existed && p.watchlistId && !keptIds.has(p.watchlistId) && !declaredNames.has(p.name.toLowerCase())) {
      const resp = await client.delete(`${watchlistsPath}/${p.watchlistId}`)
      if (!resp.ok && resp.status !== 404) failures.push(`delete ${p.name}: ${cbErrorMessage(resp)}`)
    }
  }

  if (failures.length) {
    return { success: false, message: `Some watchlists failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} watchlist(s)`, rollbackData: { entries } }
}
