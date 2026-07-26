import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient, SAVED_SEARCH_API_VERSION, type SentinelClient } from '../../lib/sentinel'
import { extractSavedSearchSpecs } from './validate'

export interface LiveSavedSearch {
  name?: string
  properties?: { category?: string; displayName?: string; query?: string; functionAlias?: string; functionParameters?: string }
}

/** List the workspace's saved searches; throws on a non-OK response. */
export async function listSavedSearches(client: SentinelClient): Promise<LiveSavedSearch[]> {
  const res = await client.getAll<LiveSavedSearch>(client.workspaceChildPath('/savedSearches'), SAVED_SEARCH_API_VERSION)
  if (!res.ok) {
    throw new Error(res.body ? res.body.slice(0, 300) : `HTTP ${res.status}`)
  }
  return res.items
}

/**
 * Health check for hunting queries / saved searches:
 *   1. ARM reachability + token/permission validity (a savedSearches list)
 *   2. Every declared saved search still exists
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
  let live: LiveSavedSearch[] | null = null
  try {
    live = await listSavedSearches(client)
    checks.push({ name: 'arm_reachable', passed: true, message: `Azure Resource Manager reachable at ${armHost}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'arm_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const ids = new Set(live.filter((s) => s.name).map((s) => (s.name as string).toLowerCase()))
    for (const spec of extractSavedSearchSpecs(ctx.canvas).filter((s) => s.name)) {
      const present = ids.has(spec.savedSearchId.toLowerCase())
      checks.push({
        name: `hunting_query:${spec.name}`,
        passed: present,
        message: present ? `Hunting query "${spec.name}" is present` : `Hunting query "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
