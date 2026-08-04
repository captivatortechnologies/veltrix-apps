import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage } from '../../lib/elastic'
import { getRole } from './deploy'
import { extractRoleSpecs } from './validate'

/**
 * Health check for role configuration:
 *   1. Elasticsearch reachability + credential validity (GET /_security/role).
 *      A 401/403 means the credential was rejected (or lacks manage_security).
 *      This request also fails (status 0) when the "Elasticsearch URL" app
 *      setting is unset.
 *   2. Every declared role still exists in the cluster.
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'elastic_credential', passed: false, message: built.error }] }
  }
  const { client } = built

  const reachable = await timedCheck('elasticsearch_reachable', async () => {
    const res = await client.elasticsearch('GET', '/_security/role')
    if (res.status === 401 || res.status === 403) {
      throw new Error('Elasticsearch rejected the credential (check the API key privileges — roles need manage_security)')
    }
    if (!res.ok) throw new Error(elasticErrorMessage(res))
    return 'Elasticsearch _security/role API reachable and credential accepted'
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractRoleSpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`role:${spec.name}`, async () => {
          const live = await getRole(client, spec.name)
          if (!live) throw new Error(`Role "${spec.name}" does not exist in the cluster`)
          return `Role "${spec.name}" is present`
        }),
      )
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)

  return { healthy: passedCount === checks.length, score, checks }
}

async function timedCheck(name: string, fn: () => Promise<string>): Promise<HealthCheckResult['checks'][0]> {
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
