import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildTeleportClient, teleportErrorMessage } from '../../lib/teleport'
import { getDiscoveryConfig } from './deploy'
import { extractDiscoveryConfigSpecs } from './validate'

/**
 * Health check for discovery config:
 *   1. The session logs in and can list discovery configs on the target cluster/site
 *   2. Every declared config still exists
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildTeleportClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'teleport_credential', passed: false, message: built.error }],
    }
  }
  const { client, baseUrl } = built

  const reachable = await timedCheck('teleport_session', async () => {
    const site = await client.resolveSite()
    const res = await client.request('GET', `/v1/webapi/sites/${encodeURIComponent(site)}/discoveryconfig`)
    if (!res.ok) throw new Error(teleportErrorMessage(res))
    return `Logged in and listed discovery configs on cluster "${site}" at ${baseUrl}`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractDiscoveryConfigSpecs(ctx.canvas).filter((s) => s.name && s.discoveryGroup)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`discovery-config:${spec.name}`, async () => {
          const live = await getDiscoveryConfig(client, spec.name)
          if (!live) throw new Error(`Discovery config "${spec.name}" does not exist in Teleport`)
          return `Discovery config "${spec.name}" is present`
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
