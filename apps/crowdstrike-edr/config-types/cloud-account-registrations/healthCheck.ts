import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconErrorMessage } from '../../lib/falcon'
import { findAccount } from './deploy'
import { accountIdentity, extractAccountSpecs } from './validate'

/**
 * Health check for cloud account registrations:
 *   1. Falcon Cloud Security API reachability + credential validity (CSPM
 *      registration Read scope)
 *   2. Every declared account is registered in the tenant
 * Score is the percentage of passed checks (0–100).
 *
 * This verifies REGISTRATION, not full activation — an account shows as
 * registered before the customer runs the setup CloudFormation/ARM/Terraform
 * out-of-band, and only after that step does assessment actually run.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'falcon_credential', passed: false, message: built.error }],
    }
  }
  const { client, baseUrl } = built

  // Check 1: API reachable and the client has the CSPM registration Read scope.
  // A bare account GET returns 200 with all registered AWS accounts (possibly
  // none) — enough to prove reachability + scope regardless of which providers
  // the canvas declares.
  const reachable = await timedCheck('falcon_reachable', async () => {
    const res = await client.request('GET', '/cloud-connect-cspm-aws/entities/account/v1', {})
    if (res.status === 401) throw new Error('Falcon API client rejected (401) — check the client secret')
    if (res.status === 403) {
      throw new Error('Falcon API client lacks the "CSPM registration: Read" scope (403)')
    }
    if (!res.ok) throw new Error(falconErrorMessage(res))
    return `Falcon Cloud Security API reachable at ${baseUrl}`
  })
  checks.push(reachable)

  // Check 2..n: each declared account is registered
  if (reachable.passed) {
    const specs = extractAccountSpecs(ctx.canvas).filter((s) => accountIdentity(s))
    for (const spec of specs) {
      const identity = accountIdentity(spec)
      const label = `${spec.cloudProvider}:${identity}`
      checks.push(
        await timedCheck(`account:${label}`, async () => {
          const live = await findAccount(client, spec.cloudProvider, identity)
          if (!live) {
            throw new Error(`${label} is not registered in the tenant`)
          }
          return `${label} is registered`
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
