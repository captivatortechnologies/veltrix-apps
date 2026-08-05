import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildPingOneClient, parseJson, pingOneErrorMessage } from '../../lib/pingOne'
import { findRiskPolicySet } from './deploy'
import { extractRiskPolicySetSpecs } from './validate'

/**
 * Health check for risk policy configuration:
 *   1. PingOne environment reachability + worker credential validity
 *      (GET /environments/{id} - a 401/403 means the worker Client ID/Secret
 *      was rejected or lacks the role needed to read the environment).
 *   2. Every declared risk policy set (re-found by name) still exists.
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
    const res = await client.request('GET', '')
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        'PingOne rejected the worker credentials (check the Client ID/Secret and its role assignment)',
      )
    }
    if (!res.ok) throw new Error(pingOneErrorMessage(res))
    const env = parseJson<{ name?: string }>(res.body)
    return `PingOne environment ${environmentId} reachable${env?.name ? ` ("${env.name}")` : ''}`
  })
  checks.push(reachable)

  // Check 2..n: each declared risk policy set still exists (re-found by name).
  if (reachable.passed) {
    const specs = extractRiskPolicySetSpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`risk-policy-set:${spec.name}`, async () => {
          const live = await findRiskPolicySet(client, spec.name)
          if (!live) throw new Error(`Risk policy set "${spec.name}" does not exist in the environment`)
          return `Risk policy set "${spec.name}" is present`
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
