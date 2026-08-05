import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, pingOneErrorMessage } from '../../lib/pingOne'
import { findGroupMatch, listGroups } from './deploy'
import { extractGroupSpecs, type LiveGroup } from './validate'

/**
 * Health check for group configuration:
 *   1. PingOne environment reachability + worker-token validity (GET the
 *      environment itself - see handlers/testConnection.ts for the same
 *      check; 401/403 => worker credentials rejected)
 *   2. Every declared group still exists, matched on its logical identity -
 *      the PAIR (name, population.id)
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildPingOneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'pingone_credential', passed: false, message: built.error }],
    }
  }
  const { client, environmentId } = built

  // Check 1: environment reachable and the worker token is accepted.
  let groups: LiveGroup[] = []
  const reachable = await timedCheck('pingone_reachable', async () => {
    const res = await client.request('GET', '')
    if (res.status === 401 || res.status === 403) {
      throw new Error('PingOne rejected the worker credentials (invalid client id/secret, or missing role)')
    }
    if (!res.ok) throw new Error(pingOneErrorMessage(res))
    // Prime the group list for the per-group checks below.
    groups = await listGroups(client)
    return `PingOne environment ${environmentId} reachable`
  })
  checks.push(reachable)

  // Check 2..n: each declared group still exists, matched on (name, population.id).
  if (reachable.passed) {
    const specs = extractGroupSpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      const label = spec.populationId ? `${spec.name} (population ${spec.populationId})` : spec.name
      checks.push(
        await timedCheck(`group:${label}`, async () => {
          const live = findGroupMatch(groups, spec.name, spec.populationId)
          if (!live) throw new Error(`Group "${label}" does not exist in the environment`)
          return `Group "${label}" is present`
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
