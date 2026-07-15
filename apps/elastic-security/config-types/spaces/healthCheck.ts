import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage, parseJson } from '../../lib/elastic'
import { SPACES_SPACE, getSpace } from './deploy'
import { extractSpaceSpecs, type LiveSpace } from './validate'

/**
 * Health check for space configuration:
 *   1. Kibana reachability + credential validity (GET /api/spaces/space)
 *   2. Every declared space still exists in the deployment
 * Score is the percentage of passed checks (0-100).
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

  // Check 1: Kibana reachable and the credential is accepted (lists spaces).
  const reachable = await timedCheck('kibana_reachable', async () => {
    const res = await client.kibana('GET', '/api/spaces/space', { space: SPACES_SPACE })
    if (res.status === 401 || res.status === 403) {
      throw new Error('Kibana rejected the credential (check the Elastic API key / permissions)')
    }
    if (!res.ok) throw new Error(elasticErrorMessage(res))
    const spaces = parseJson<LiveSpace[]>(res.body) ?? []
    return `Kibana reachable at ${kibanaUrl} (${spaces.length} space(s) visible)`
  })
  checks.push(reachable)

  // Check 2..n: each declared space still exists.
  if (reachable.passed) {
    const specs = extractSpaceSpecs(ctx.canvas).filter((s) => s.id && s.name)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`space:${spec.id}`, async () => {
          const live = await getSpace(client, spec.id)
          if (!live) throw new Error(`Space "${spec.id}" does not exist in the deployment`)
          return `Space "${spec.id}" is present`
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
