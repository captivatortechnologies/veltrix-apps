import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, pingOneErrorMessage } from '../../lib/pingOne'
import { findApplication } from './deploy'
import { extractApplicationSpecs } from './validate'

/**
 * Health check for application configuration:
 *   1. PingOne environment reachability + worker credential validity
 *      (GET /applications - proves the token is accepted and the environment
 *      is readable; 401/403 means the worker credential was rejected)
 *   2. Every declared application still exists in the environment (re-found by name)
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

  // Check 1: environment reachable and the worker credential is accepted.
  const reachable = await timedCheck('pingone_reachable', async () => {
    const res = await client.request('GET', '/applications', { query: { limit: 1 } })
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        'PingOne rejected the worker credential - check the Client ID/Secret and its assigned roles',
      )
    }
    if (!res.ok) throw new Error(pingOneErrorMessage(res))
    return `PingOne environment ${environmentId} reachable`
  })
  checks.push(reachable)

  // Check 2..n: each declared application still exists (re-found by name).
  if (reachable.passed) {
    const specs = extractApplicationSpecs(ctx.canvas).filter((s) => s.name && s.protocol)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`application:${spec.name}`, async () => {
          const live = await findApplication(client, spec.name)
          if (!live) throw new Error(`Application "${spec.name}" does not exist in the PingOne environment`)
          return `Application "${spec.name}" is present`
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
