import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { searchQueues, type LiveQueue } from '../../lib/trafficShaperApi'
import { buildOpnsenseClient } from '../../lib/opnsenseApi'
import { extractQueueSpecs, queueKey } from './_shared'

/**
 * Health check for OPNsense traffic-shaper-queues configuration: API
 * reachability + credential validity (searchQueues), then every declared
 * queue (by description) still exists. Read-only.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'opnsense_credential', passed: false, message: built.error }] }
  }
  const { client, host } = built

  const specs = extractQueueSpecs(ctx.canvas).filter((s) => s.description)
  let live: LiveQueue[] = []
  const started = Date.now()

  try {
    live = await searchQueues(client)
    checks.push({
      name: 'opnsense_reachable',
      passed: true,
      message: `Reached the OPNsense API at ${host}`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'opnsense_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'searchQueues failed',
      latencyMs: Date.now() - started,
    })
  }

  if (checks[0]?.passed) {
    const keys = new Set(live.filter((q) => q.description).map((q) => queueKey(q.description as string)))
    for (const spec of specs) {
      const present = keys.has(queueKey(spec.description))
      checks.push({
        name: `queue:${spec.description}`,
        passed: present,
        message: present ? `Queue "${spec.description}" is present` : `Queue "${spec.description}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
