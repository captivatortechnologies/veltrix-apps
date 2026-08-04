import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage } from '../../lib/elastic'
import { getTag } from './deploy'
import { extractTagSpecs } from './validate'

/**
 * Health check for tag configuration:
 *   1. Kibana reachability + credential validity (GET /api/tags — search tags).
 *   2. Every declared tag still exists.
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'elastic_credential', passed: false, message: built.error }] }
  }
  const { client, kibanaUrl } = built

  const reachable = await timedCheck('kibana_reachable', async () => {
    const res = await client.kibana('GET', '/api/tags')
    if (res.status === 401 || res.status === 403) {
      throw new Error('Kibana rejected the credential (check the Elastic API key / permissions)')
    }
    if (!res.ok) throw new Error(elasticErrorMessage(res))
    return `Kibana Tags API reachable at ${kibanaUrl}`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractTagSpecs(ctx.canvas).filter((s) => s.id)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`tag:${spec.id}`, async () => {
          const live = await getTag(client, spec.id)
          if (!live) throw new Error(`Tag "${spec.id}" does not exist`)
          return `Tag "${spec.id}" is present`
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
