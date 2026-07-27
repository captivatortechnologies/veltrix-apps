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
import { extractWatchlistSpecs, type WatchlistSpec, type LiveWatchlist } from './validate'

// A watchlist's id is server-assigned, so identity is the displayName we own.
// Entity membership is populated out-of-band (entityPopulationMechanism.manual)
// and is NOT part of this config object — only the watchlist definition is managed.
export interface RollbackEntry {
  itemId?: string
  displayName: string
  /** Whether the watchlist existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  /** The server-assigned watchlistId, kept so rollback/reconcile can target it after a rename. */
  watchlistId?: string
  prior?: { displayName: string; description: string; multiplyingFactor: number; pinned: boolean }
}

const enc = encodeURIComponent
const UPDATE_MASK = 'displayName,description,multiplyingFactor,watchlistUserPreferences'

export function watchlistBody(spec: WatchlistSpec): Record<string, unknown> {
  return {
    displayName: spec.displayName,
    description: spec.description,
    multiplyingFactor: spec.multiplyingFactor,
    entityPopulationMechanism: { manual: {} },
    watchlistUserPreferences: { pinned: spec.pinned },
  }
}

/** The server-assigned watchlistId at the tail of a `{parent}/watchlists/{id}` name. */
export function watchlistIdOf(name: string): string {
  return name.split('/').pop() ?? ''
}

/** List every watchlist under the parent, following pagination. */
export async function listWatchlists(client: SecOpsClient, parent: string): Promise<{ ok: boolean; watchlists: LiveWatchlist[]; error?: string }> {
  const watchlists: LiveWatchlist[] = []
  let pageToken = ''
  do {
    const query = pageToken ? `?pageSize=1000&pageToken=${enc(pageToken)}` : '?pageSize=1000'
    const res = await client.request('GET', `${parent}/watchlists${query}`)
    if (!res.ok) return { ok: false, watchlists, error: secopsErrorMessage(res) }
    const parsed = parseJson<{ watchlists?: LiveWatchlist[]; nextPageToken?: string }>(res.body)
    if (parsed?.watchlists) watchlists.push(...parsed.watchlists)
    pageToken = parsed?.nextPageToken ?? ''
  } while (pageToken)
  return { ok: true, watchlists }
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

  const specs = extractWatchlistSpecs(ctx.canvas).filter((s) => s.displayName)
  const prior = await loadPriorEntries(ctx)

  const listed = await listWatchlists(client, parent)
  if (!listed.ok) return { success: false, message: `Could not list Google SecOps watchlists: ${listed.error}` }
  const byWatchlistId = new Map(listed.watchlists.map((w) => [watchlistIdOf(w.name ?? ''), w]))
  const byDisplayName = new Map(listed.watchlists.map((w) => [w.displayName ?? '', w]))
  const priorByItem = new Map(prior.filter((p) => p.itemId).map((p) => [p.itemId!, p]))

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    const priorEntry = spec.itemId ? priorByItem.get(spec.itemId) : undefined
    const live = (priorEntry?.watchlistId ? byWatchlistId.get(priorEntry.watchlistId) : undefined) ?? byDisplayName.get(spec.displayName)

    if (live) {
      const watchlistId = watchlistIdOf(live.name ?? '')
      const priorState = {
        displayName: live.displayName ?? spec.displayName,
        description: live.description ?? '',
        multiplyingFactor: live.multiplyingFactor ?? 1,
        pinned: live.watchlistUserPreferences?.pinned ?? false,
      }
      const resp = await client.request('PATCH', `${parent}/watchlists/${enc(watchlistId)}?updateMask=${UPDATE_MASK}`, watchlistBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.displayName}: ${secopsErrorMessage(resp)}`)
        continue
      }
      entries.push({ itemId: spec.itemId, displayName: spec.displayName, existed: true, watchlistId, prior: priorState })
    } else {
      const resp = await client.request('POST', `${parent}/watchlists`, watchlistBody(spec))
      if (!resp.ok) {
        failures.push(`${spec.displayName}: ${secopsErrorMessage(resp)}`)
        continue
      }
      const created = parseJson<LiveWatchlist>(resp.body)
      entries.push({ itemId: spec.itemId, displayName: spec.displayName, existed: false, watchlistId: watchlistIdOf(created?.name ?? '') })
    }
  }

  // Reconcile: delete watchlists THIS app created previously but no longer declares.
  const declaredNames = new Set(specs.map((s) => s.displayName.toLowerCase()))
  const declaredItems = new Set(specs.map((s) => s.itemId).filter(Boolean))
  for (const p of prior) {
    if (p.existed || !p.watchlistId) continue
    if ((p.itemId && declaredItems.has(p.itemId)) || declaredNames.has(p.displayName.toLowerCase())) continue
    const del = await client.request('DELETE', `${parent}/watchlists/${enc(p.watchlistId)}?force=true`)
    if (!del.ok && del.status !== 404) failures.push(`delete ${p.displayName}: ${secopsErrorMessage(del)}`)
  }

  if (failures.length) {
    return { success: false, message: `Some watchlists failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} watchlist(s)`, rollbackData: { entries } }
}
