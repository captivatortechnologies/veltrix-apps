import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient } from '../../lib/sentinel'
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

  try {
    const live = await listWatchlists(client)
    const byAlias = new Map<string, LiveWatchlist>()
    for (const w of live) byAlias.set((w.properties?.watchlistAlias ?? w.name ?? '').toLowerCase(), w)

    for (const spec of specs) {
      const liveWatchlist = byAlias.get(watchlistKey(spec.alias))
      if (!liveWatchlist) {
        diffs.push({ field: `watchlist:${spec.alias}`, expected: 'exists', actual: 'missing', severity: 'critical' })
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
    }
  } catch (error) {
    diffs.push({ field: 'sentinel', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
