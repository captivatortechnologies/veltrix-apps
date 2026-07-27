import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconErrorMessage } from '../../lib/falcon'
import { SCHEDULED_EXCLUSION_ENDPOINTS, findScheduledExclusionByName } from './deploy'
import { extractScheduledExclusionSpecs } from './validate'

/**
 * Health check for scheduled-exclusion configuration:
 *   1. Falcon API reachability + credential validity (FileVantage scope),
 *      probed against the first declared exclusion's policy
 *   2. Every declared exclusion exists in its policy
 * Score is the percentage of passed checks (0–100).
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

  const specs = extractScheduledExclusionSpecs(ctx.canvas).filter((s) => s.name && s.policyId)
  if (specs.length === 0) {
    return {
      healthy: true,
      score: 100,
      checks: [{ name: 'no_exclusions', passed: true, message: 'No scheduled exclusions declared' }],
    }
  }

  // Check 1: API reachable and the client has the FileVantage scope. The query
  // endpoint requires a policy_id, so this probes the first exclusion's policy.
  const reachable = await timedCheck('falcon_reachable', async () => {
    const res = await client.request('GET', SCHEDULED_EXCLUSION_ENDPOINTS.queries, {
      query: { policy_id: specs[0].policyId },
    })
    if (res.status === 401) throw new Error('Falcon API client rejected (401) — check the client secret')
    if (res.status === 403) {
      throw new Error('Falcon API client lacks the "FileVantage: Read" scope (403)')
    }
    if (res.status === 404) throw new Error(`FileVantage policy ${specs[0].policyId} was not found`)
    if (!res.ok) throw new Error(falconErrorMessage(res))
    return `Falcon FileVantage API reachable at ${baseUrl}`
  })
  checks.push(reachable)

  // Check 2..n: each declared exclusion exists in its policy
  if (reachable.passed) {
    for (const spec of specs) {
      checks.push(
        await timedCheck(`scheduled-exclusion:${spec.name}`, async () => {
          const live = await findScheduledExclusionByName(client, spec.policyId, spec.name)
          if (!live) {
            throw new Error(
              `Scheduled exclusion "${spec.name}" does not exist in policy ${spec.policyId}`,
            )
          }
          return `Scheduled exclusion "${spec.name}" is present`
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
