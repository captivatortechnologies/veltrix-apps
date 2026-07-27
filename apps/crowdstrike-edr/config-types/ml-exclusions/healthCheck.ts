import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconErrorMessage } from '../../lib/falcon'
import { findExclusion } from '../../lib/exclusionAdapter'
import { timedCheck } from './exclusionShared'
import { ML_EXCLUSION_ENDPOINTS } from './deploy'
import { extractMlExclusionSpecs } from './validate'

/**
 * Health check for ML exclusion configuration:
 *   1. Falcon API reachability + credential validity (ML Exclusions scope)
 *   2. Every declared exclusion exists in the tenant
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

  // Check 1: API reachable and the client has the ML Exclusions scope
  const reachable = await timedCheck('falcon_reachable', async () => {
    const res = await client.request('GET', ML_EXCLUSION_ENDPOINTS.queries, { query: { limit: 1 } })
    if (res.status === 401) throw new Error('Falcon API client rejected (401) — check the client secret')
    if (res.status === 403) {
      throw new Error('Falcon API client lacks the "ML Exclusions: Read" scope (403)')
    }
    if (!res.ok) throw new Error(falconErrorMessage(res))
    return `Falcon API reachable at ${baseUrl}`
  })
  checks.push(reachable)

  // Check 2..n: each declared exclusion exists
  if (reachable.passed) {
    const specs = extractMlExclusionSpecs(ctx.canvas).filter((s) => s.value)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`ml-exclusion:${spec.value}`, async () => {
          const live = await findExclusion(client, ML_EXCLUSION_ENDPOINTS, spec.value)
          if (!live) {
            throw new Error(`ML exclusion "${spec.value}" does not exist in the tenant`)
          }
          return `ML exclusion "${spec.value}" is present`
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
