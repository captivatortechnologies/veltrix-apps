import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildTwingateClient } from '../../lib/twingateApi'
import { listResources } from './deploy'
import { extractResourceSpecs, resourceKey, type LiveResource } from './_shared'

/**
 * Health check for Resource configuration:
 *   1. Twingate GraphQL reachability + API key validity (a resource list)
 *   2. Every declared resource (by name) still exists
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildTwingateClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'twingate_credential', passed: false, message: built.error }] }
  }
  const { client, graphqlUrl } = built

  const specs = extractResourceSpecs(ctx.canvas).filter((s) => s.name && s.address && s.remoteNetworkName)

  const reachable = await timedCheck('twingate_reachable', async () => {
    const live = await listResources(client)
    return { message: `Twingate reachable at ${graphqlUrl}`, live }
  })
  checks.push({ name: reachable.name, passed: reachable.passed, message: reachable.message, latencyMs: reachable.latencyMs })

  if (reachable.passed && reachable.live) {
    const names = new Set(reachable.live.filter((r) => r.name).map((r) => resourceKey(r.name as string)))
    for (const spec of specs) {
      const present = names.has(resourceKey(spec.name))
      checks.push({
        name: `resource:${spec.name}`,
        passed: present,
        message: present ? `Resource "${spec.name}" is present` : `Resource "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

async function timedCheck(
  name: string,
  fn: () => Promise<{ message: string; live?: LiveResource[] }>,
): Promise<{ name: string; passed: boolean; message: string; latencyMs: number; live?: LiveResource[] }> {
  const start = Date.now()
  try {
    const { message, live } = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start, live }
  } catch (error) {
    return { name, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start }
  }
}
