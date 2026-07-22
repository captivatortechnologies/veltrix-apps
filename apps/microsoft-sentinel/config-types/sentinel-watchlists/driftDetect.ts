import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient } from '../../lib/sentinel'
import { attachDriftActor, veltrixActorLogins } from '../../lib/sentinelActivityLog'
import { listWatchlists, type LiveWatchlist } from './healthCheck'
import { extractWatchlistSpecs, watchlistKey } from './validate'

/**
 * Detect drift between the deployed watchlists and the live workspace. A declared
 * watchlist that no longer exists is critical drift; a metadata field that differs
 * (display name, provider, search key) is warning drift. Item content is not
 * compared — GET does not return rawContent.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractWatchlistSpecs(ctx.deployedConfig).filter((s) => s.alias)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Veltrix's own deploys authenticate as the app registration — excluded so
  // attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const live = await listWatchlists(client)
    const byAlias = new Map<string, LiveWatchlist>()
    for (const w of live) byAlias.set((w.properties?.watchlistAlias ?? w.name ?? '').toLowerCase(), w)

    for (const spec of specs) {
      const before = diffs.length
      const resourceId = client.sentinelPath(`/watchlists/${spec.alias}`)
      const liveWatchlist = byAlias.get(watchlistKey(spec.alias))
      if (!liveWatchlist) {
        diffs.push({ field: `watchlist:${spec.alias}`, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { resourceId, excludeActorLogins })
        continue
      }
      const props = liveWatchlist.properties ?? {}
      const comparisons: Array<{ label: string; want: string; have: string }> = [
        { label: 'displayName', want: spec.displayName, have: props.displayName ?? '' },
        { label: 'provider', want: spec.provider, have: props.provider ?? '' },
        { label: 'itemsSearchKey', want: spec.itemsSearchKey, have: props.itemsSearchKey ?? '' },
      ]
      for (const { label, want, have } of comparisons) {
        if (want !== have) {
          diffs.push({ field: `${spec.alias}.${label}`, expected: want, actual: have, severity: 'warning' })
        }
      }
      // Attribute every diff this watchlist produced to the last human change
      // (once); a no-op (no query) when the watchlist did not drift.
      await attachDriftActor(client, diffs.slice(before), { resourceId, excludeActorLogins })
    }
  } catch (error) {
    diffs.push({ field: 'sentinel', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
