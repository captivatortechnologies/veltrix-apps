import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage } from '../../lib/elastic'
import { getTransform, getTransformState } from './deploy'
import { extractTransformSpecs } from './validate'

/**
 * Health check for transform configuration:
 *   1. Elasticsearch reachability + credential validity (GET /_transform).
 *      A 401/403 means the credential was rejected (or lacks manage_transform).
 *   2. Every declared transform still exists, and — when Enabled — is not in
 *      a failed state.
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
    const res = await client.elasticsearch('GET', '/_transform')
    if (res.status === 401 || res.status === 403) {
      throw new Error('Elasticsearch rejected the credential (check the API key privileges — transforms need manage_transform)')
    }
    if (!res.ok) throw new Error(elasticErrorMessage(res))
    return 'Elasticsearch _transform API reachable and credential accepted'
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractTransformSpecs(ctx.canvas).filter((s) => s.transformId)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`transform:${spec.transformId}`, async () => {
          const live = await getTransform(client, spec.transformId)
          if (!live) throw new Error(`Transform "${spec.transformId}" does not exist in the cluster`)
          if (spec.enabled) {
            const state = await getTransformState(client, spec.transformId)
            if (state === 'failed') throw new Error(`Transform "${spec.transformId}" is in a FAILED state`)
          }
          return `Transform "${spec.transformId}" is present`
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
