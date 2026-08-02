import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildTwingateClient } from '../../lib/twingateApi'
import { listGroups } from './deploy'
import { extractGroupSpecs, groupKey, isExternallyManaged, type LiveGroup } from './_shared'

/**
 * Health check for Group configuration:
 *   1. Twingate GraphQL reachability + API key validity (a group list)
 *   2. Every declared group (by name) still exists as a MANUAL group
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildTwingateClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'twingate_credential', passed: false, message: built.error }] }
  }
  const { client, graphqlUrl } = built

  const specs = extractGroupSpecs(ctx.canvas).filter((s) => s.name)

  const reachable = await timedCheck('twingate_reachable', async () => {
    const live = await listGroups(client)
    return { message: `Twingate reachable at ${graphqlUrl}`, live }
  })
  checks.push({ name: reachable.name, passed: reachable.passed, message: reachable.message, latencyMs: reachable.latencyMs })

  if (reachable.passed && reachable.live) {
    const byName = new Map(reachable.live.filter((g) => g.name).map((g) => [groupKey(g.name as string), g]))
    for (const spec of specs) {
      const found = byName.get(groupKey(spec.name))
      const present = !!found?.id && !isExternallyManaged(found.type)
      checks.push({
        name: `group:${spec.name}`,
        passed: present,
        message: present ? `Group "${spec.name}" is present` : `Group "${spec.name}" is missing or externally managed`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

async function timedCheck(
  name: string,
  fn: () => Promise<{ message: string; live?: LiveGroup[] }>,
): Promise<{ name: string; passed: boolean; message: string; latencyMs: number; live?: LiveGroup[] }> {
  const start = Date.now()
  try {
    const { message, live } = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start, live }
  } catch (error) {
    return { name, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start }
  }
}
