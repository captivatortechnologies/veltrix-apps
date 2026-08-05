import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, pingOneErrorMessage } from '../../lib/pingOne'
import { findPasswordPolicyByName } from './deploy'
import { extractPasswordPolicySpecs } from './validate'

/**
 * Health check for password-policy configuration:
 *   1. PingOne API reachability + worker credential validity (GET on the
 *      environment root; 401/403 means the worker token was rejected)
 *   2. Every declared policy still exists in the environment (re-found by
 *      exact name)
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

  const reachable = await timedCheck('pingone_reachable', async () => {
    const res = await client.request('GET', '')
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        'PingOne rejected the worker credential - check the Client ID/Secret and that the worker application has the roles this app needs',
      )
    }
    if (!res.ok) throw new Error(pingOneErrorMessage(res))
    return `PingOne environment ${environmentId} reachable`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractPasswordPolicySpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`password-policy:${spec.name}`, async () => {
          const live = await findPasswordPolicyByName(client, spec.name)
          if (!live) throw new Error(`Password policy "${spec.name}" does not exist in the PingOne environment`)
          return `Password policy "${spec.name}" is present`
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
