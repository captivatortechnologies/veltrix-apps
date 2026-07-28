import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient, parseJson, SENTINEL_API_VERSION, type SentinelClient } from '../../lib/sentinel'
import { extractIndicatorSpecs, indicatorKey, MANAGED_SOURCE } from './validate'

/** A live threat intelligence indicator (only the fields the config type reads). */
export interface LiveIndicator {
  name?: string
  /** Full ARM resource id — the correlation key for drift attribution. */
  id?: string
  kind?: string
  etag?: string
  properties?: Record<string, unknown>
}

/** Extract the continuation `skipToken` from a queryIndicators nextLink, if any. */
function extractSkipToken(nextLink?: string): string | null {
  if (!nextLink) return null
  try {
    const url = new URL(nextLink)
    return url.searchParams.get('$skipToken') ?? url.searchParams.get('skipToken')
  } catch {
    return null
  }
}

/**
 * Query every indicator of the managed source via the queryIndicators action,
 * paging through the returned nextLink's skipToken. Scoping the query to the
 * managed `source` means connector/TAXII/MDTI-fed indicators are never returned,
 * so presence, drift and reconciliation only ever see Veltrix-owned indicators.
 * Throws on a non-OK response.
 */
export async function queryManagedIndicators(client: SentinelClient): Promise<LiveIndicator[]> {
  const path = client.sentinelPath('/threatIntelligence/main/queryIndicators')
  const items: LiveIndicator[] = []
  let skipToken: string | null = null
  const maxPages = 50

  for (let page = 0; page < maxPages; page++) {
    const body: Record<string, unknown> = { sources: [MANAGED_SOURCE], pageSize: 100, includeDisabled: true }
    if (skipToken) body.skipToken = skipToken
    const res = await client.request('POST', path, { apiVersion: SENTINEL_API_VERSION, body })
    if (!res.ok) throw new Error(res.body ? res.body.slice(0, 300) : `HTTP ${res.status}`)
    const env = parseJson<{ value?: LiveIndicator[]; nextLink?: string }>(res.body)
    if (Array.isArray(env?.value)) items.push(...env!.value!)
    skipToken = extractSkipToken(env?.nextLink)
    if (!skipToken) break
  }
  return items
}

/** The live display name of an indicator, lower-cased for matching. */
function liveDisplayName(ind: LiveIndicator): string {
  const dn = typeof ind.properties?.displayName === 'string' ? ind.properties.displayName : ''
  return dn.toLowerCase()
}

/**
 * Health check for threat intelligence indicators:
 *   1. ARM reachability + token/permission validity (a managed-source query)
 *   2. Every declared indicator still exists in the managed source
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'sentinel_credential', passed: false, message: built.error }] }
  }
  const { client, armHost } = built

  const start = Date.now()
  let live: LiveIndicator[] | null = null
  try {
    live = await queryManagedIndicators(client)
    checks.push({ name: 'arm_reachable', passed: true, message: `Azure Resource Manager reachable at ${armHost}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'arm_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const names = new Set(live.map(liveDisplayName).filter((n) => n))
    for (const spec of extractIndicatorSpecs(ctx.canvas).filter((s) => s.displayName)) {
      const present = names.has(indicatorKey(spec.displayName))
      checks.push({
        name: `indicator:${spec.displayName}`,
        passed: present,
        message: present ? `Indicator "${spec.displayName}" is present` : `Indicator "${spec.displayName}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
