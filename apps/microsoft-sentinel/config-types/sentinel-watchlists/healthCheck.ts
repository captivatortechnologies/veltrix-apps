import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient, SENTINEL_API_VERSION, type SentinelClient } from '../../lib/sentinel'
import { extractWatchlistSpecs, watchlistKey } from './validate'

export interface LiveWatchlist {
  name?: string
  properties?: { displayName?: string; provider?: string; itemsSearchKey?: string; watchlistAlias?: string; provisioningState?: string }
}

/** List the workspace's watchlists; throws on a non-OK response. */
export async function listWatchlists(client: SentinelClient): Promise<LiveWatchlist[]> {
  const res = await client.getAll<LiveWatchlist>(client.sentinelPath('/watchlists'), SENTINEL_API_VERSION)
  if (!res.ok) {
    throw new Error(res.body ? res.body.slice(0, 300) : `HTTP ${res.status}`)
  }
  return res.items
}

/** The live alias of a watchlist (falls back to the resource name). */
function liveAlias(w: LiveWatchlist): string {
  return (w.properties?.watchlistAlias ?? w.name ?? '').toLowerCase()
}

/**
 * Health check for watchlists:
 *   1. ARM reachability + token/permission validity (a watchlists list)
 *   2. Every declared watchlist still exists
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'sentinel_credential', passed: false, message: built.error }] }
  }
  const { client, armHost } = built

  const start = Date.now()
  let live: LiveWatchlist[] | null = null
  try {
    live = await listWatchlists(client)
    checks.push({ name: 'arm_reachable', passed: true, message: `Azure Resource Manager reachable at ${armHost}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'arm_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const aliases = new Set(live.map(liveAlias))
    for (const spec of extractWatchlistSpecs(ctx.canvas).filter((s) => s.alias)) {
      const present = aliases.has(watchlistKey(spec.alias))
      checks.push({
        name: `watchlist:${spec.alias}`,
        passed: present,
        message: present ? `Watchlist "${spec.alias}" is present` : `Watchlist "${spec.alias}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
