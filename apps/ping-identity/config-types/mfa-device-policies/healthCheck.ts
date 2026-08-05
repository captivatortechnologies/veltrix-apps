import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, pingOneErrorMessage } from '../../lib/pingOne'
import { findPolicyByName } from './deploy'
import { extractPolicySpecs } from './validate'

/**
 * Health check for MFA device policy configuration:
 *   1. PingOne environment reachability + worker credential validity (a plain
 *      GET against the environment root; 401/403 means the worker
 *      credentials were rejected or lack access)
 *   2. Every declared policy still exists (re-found by name)
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
  const { client, environmentId, region } = built

  // Check 1: environment reachable and the worker credentials are accepted.
  const reachable = await timedCheck('pingone_reachable', async () => {
    const res = await client.request('GET', '')
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        'PingOne rejected the worker credentials or denied access (check the worker Client ID/Secret and its role assignment)',
      )
    }
    if (!res.ok) throw new Error(pingOneErrorMessage(res))
    return `PingOne environment ${environmentId} reachable (region ${region})`
  })
  checks.push(reachable)

  // Check 2..n: each declared policy still exists (re-found by name).
  if (reachable.passed) {
    const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`policy:${spec.name}`, async () => {
          const live = await findPolicyByName(client, spec.name)
          if (!live) throw new Error(`MFA device policy "${spec.name}" does not exist in the PingOne environment`)
          return `MFA device policy "${spec.name}" is present`
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
