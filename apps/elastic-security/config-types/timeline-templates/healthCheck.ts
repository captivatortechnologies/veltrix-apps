import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage } from '../../lib/elastic'
import { getTimelineTemplate } from './deploy'
import { extractTemplateSpecs } from './validate'

/**
 * Health check for timeline-template configuration:
 *   1. Kibana Security Timeline API reachability + credential validity
 *      (GET /api/timelines — list, per_page 1).
 *   2. Every declared template (by templateTimelineId) still exists.
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
    const res = await client.kibana('GET', '/api/timelines', { query: { page_size: 1, page_index: 1 } })
    if (res.status === 401 || res.status === 403) {
      throw new Error('Kibana rejected the credential (check the API key and its Timeline privileges)')
    }
    if (!res.ok) throw new Error(elasticErrorMessage(res))
    return `Kibana Security Timeline API reachable at ${kibanaUrl}`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractTemplateSpecs(ctx.canvas).filter((s) => s.templateTimelineId)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`template:${spec.templateTimelineId}`, async () => {
          const live = await getTimelineTemplate(client, spec.templateTimelineId)
          if (!live) throw new Error(`Timeline template "${spec.templateTimelineId}" does not exist`)
          return `Timeline template "${spec.templateTimelineId}" is present`
        }),
      )
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0

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
