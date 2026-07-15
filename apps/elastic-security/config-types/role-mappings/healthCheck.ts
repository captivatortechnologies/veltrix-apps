import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage } from '../../lib/elastic'
import { getRoleMapping } from './deploy'
import { extractMappingSpecs } from './validate'

/**
 * Health check for role-mapping configuration:
 *   1. Elasticsearch reachability + credential validity (GET /_security/role_mapping).
 *      A 401/403 means the credential was rejected (or lacks manage_security).
 *      This request also fails (status 0) when the "Elasticsearch URL" app
 *      setting is unset.
 *   2. Every declared mapping still exists in the cluster.
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
  const { client } = built

  // Check 1: Elasticsearch reachable and the credential is accepted.
  const reachable = await timedCheck('elasticsearch_reachable', async () => {
    const res = await client.elasticsearch('GET', '/_security/role_mapping')
    if (res.status === 401 || res.status === 403) {
      throw new Error('Elasticsearch rejected the credential (check the API key privileges — role mappings need manage_security)')
    }
    if (!res.ok) throw new Error(elasticErrorMessage(res))
    return 'Elasticsearch _security/role_mapping API reachable and credential accepted'
  })
  checks.push(reachable)

  // Check 2..n: each declared mapping still exists.
  if (reachable.passed) {
    const specs = extractMappingSpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`mapping:${spec.name}`, async () => {
          const live = await getRoleMapping(client, spec.name)
          if (!live) throw new Error(`Role mapping "${spec.name}" does not exist in the cluster`)
          return `Role mapping "${spec.name}" is present`
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
