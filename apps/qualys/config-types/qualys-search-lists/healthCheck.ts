import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildQualysClient } from '../../lib/qualys'
import { listSearchLists } from './deploy'
import { extractSearchListSpecs, searchListKey, type LiveSearchList } from './validate'

/**
 * Health check for search list configuration:
 *   1. Qualys platform reachability + credential validity (a paged search-list list)
 *   2. Every declared search list still exists
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'qualys_credential', passed: false, message: built.error }] }
  }
  const { client, platformUrl } = built

  const start = Date.now()
  let live: LiveSearchList[] | null = null
  try {
    live = await listSearchLists(client)
    checks.push({
      name: 'qualys_reachable',
      passed: true,
      message: `Qualys platform reachable at ${platformUrl}`,
      latencyMs: Date.now() - start,
    })
  } catch (error) {
    checks.push({
      name: 'qualys_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    })
  }

  if (live) {
    const keys = new Set(live.map((l) => searchListKey(l)))
    for (const spec of extractSearchListSpecs(ctx.canvas).filter((s) => s.title)) {
      const present = keys.has(searchListKey(spec))
      checks.push({
        name: `search_list:${spec.title}`,
        passed: present,
        message: present ? `Search list "${spec.title}" is present` : `Search list "${spec.title}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
