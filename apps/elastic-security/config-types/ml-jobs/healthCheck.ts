import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage } from '../../lib/elastic'
import { getDatafeed, getJob, getJobState } from './deploy'
import { extractJobSpecs } from './validate'

/**
 * Health check for ML job configuration:
 *   1. Elasticsearch ML API reachability + credential validity (GET /_ml/anomaly_detectors).
 *      A 401/403 means the credential was rejected (or lacks manage_ml); this
 *      also fails clearly when the cluster has no ML-enabled subscription/trial.
 *   2. Every declared job (and its datafeed) still exists, and — when
 *      Enabled — the job is not in a FAILED state.
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
    const res = await client.elasticsearch('GET', '/_ml/anomaly_detectors')
    if (res.status === 401 || res.status === 403) {
      throw new Error('Elasticsearch rejected the credential (check the API key privileges — ML jobs need manage_ml)')
    }
    if (!res.ok) throw new Error(elasticErrorMessage(res))
    return 'Elasticsearch _ml/anomaly_detectors API reachable and credential accepted (ML-enabled subscription/trial confirmed)'
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractJobSpecs(ctx.canvas).filter((s) => s.jobId)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`job:${spec.jobId}`, async () => {
          const job = await getJob(client, spec.jobId)
          if (!job) throw new Error(`ML job "${spec.jobId}" does not exist in the cluster`)
          const datafeed = await getDatafeed(client, spec.datafeedId)
          if (!datafeed) throw new Error(`Datafeed "${spec.datafeedId}" does not exist in the cluster`)
          if (spec.enabled) {
            const state = await getJobState(client, spec.jobId)
            if (state === 'failed') throw new Error(`ML job "${spec.jobId}" is in a FAILED state`)
          }
          return `ML job "${spec.jobId}" and its datafeed are present`
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
