import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage } from '../../lib/elastic'
import { getRuleByRuleId } from './deploy'
import { extractRuleSpecs } from './validate'

/**
 * Health check for detection-rule configuration:
 *   1. Kibana Detections API reachability + credential validity
 *      (GET /api/detection_engine/rules/_find?per_page=1)
 *   2. Every declared rule (by rule_id) still exists in the deployment
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

  // Check 1: Kibana reachable and the API key is accepted for the Detections API.
  const reachable = await timedCheck('kibana_reachable', async () => {
    const res = await client.kibana('GET', '/api/detection_engine/rules/_find', { query: { per_page: 1 } })
    if (res.status === 401 || res.status === 403) {
      throw new Error('Elastic rejected the credential for the Detections API (check the API key privileges)')
    }
    if (!res.ok) throw new Error(elasticErrorMessage(res))
    return `Kibana Detections API reachable at ${kibanaUrl}`
  })
  checks.push(reachable)

  // Check 2..n: each declared rule still exists (re-found by rule_id)
  if (reachable.passed) {
    const specs = extractRuleSpecs(ctx.canvas).filter((s) => s.ruleId && s.name)
    for (const spec of specs) {
      const label = spec.ruleId
      checks.push(
        await timedCheck(`rule:${label}`, async () => {
          const live = await getRuleByRuleId(client, spec.ruleId)
          if (!live) throw new Error(`Rule "${label}" does not exist in the deployment`)
          return `Rule "${label}" is present`
        }),
      )
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)

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
