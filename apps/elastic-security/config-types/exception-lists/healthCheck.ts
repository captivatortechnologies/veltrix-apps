import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage } from '../../lib/elastic'
import { findList } from './deploy'
import { extractListSpecs } from './validate'

/**
 * Health check for exception-list configuration:
 *   1. Kibana Exceptions API reachability + credential validity
 *      (GET /api/exception_lists/_find?per_page=1 — 401/403 = credential rejected)
 *   2. Every declared list (by list_id) still exists in Kibana
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'elastic_credential', passed: false, message: built.error }],
    }
  }
  const { client, kibanaUrl } = built

  // Check 1: Kibana reachable and the API key is accepted for the Exceptions API.
  const reachable = await timedCheck('kibana_reachable', async () => {
    const res = await client.kibana('GET', '/api/exception_lists/_find', { query: { per_page: 1 } })
    if (res.status === 401 || res.status === 403) {
      throw new Error('Kibana rejected the credential (check the API key and its exception-list privileges)')
    }
    if (!res.ok) throw new Error(elasticErrorMessage(res))
    return `Kibana Exceptions API reachable at ${kibanaUrl}`
  })
  checks.push(reachable)

  // Check 2..n: each declared list still exists (re-found by its list_id).
  if (reachable.passed) {
    const specs = extractListSpecs(ctx.canvas).filter((s) => s.listId && s.name)
    for (const spec of specs) {
      const label = spec.listId
      checks.push(
        await timedCheck(`list:${label}`, async () => {
          const live = await findList(client, spec.listId, spec.namespaceType)
          if (!live) throw new Error(`Exception list "${label}" does not exist in Kibana`)
          return `Exception list "${label}" is present`
        }),
      )
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0

  return {
    healthy: passedCount === checks.length,
    score,
    checks,
  }
}

async function timedCheck(
  name: string,
  fn: () => Promise<string>,
): Promise<HealthCheckResult['checks'][0]> {
  const start = Date.now()
  try {
    const message = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start }
  } catch (error) {
    return {
      name,
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    }
  }
}
