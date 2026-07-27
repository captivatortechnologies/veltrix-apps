import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconErrorMessage } from '../../lib/falcon'
import { CONTROL_ENDPOINTS, findControl } from './controlApi'
import { extractControlSpecs } from './validate'

/**
 * Health check for custom compliance control configuration:
 *   1. Falcon Cloud Security API reachability + credential validity
 *   2. Every declared control exists in its framework + section
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

  // Check 1: API reachable and the client has the Cloud Security Policies scope
  const reachable = await timedCheck('falcon_reachable', async () => {
    const res = await client.request('GET', CONTROL_ENDPOINTS.queries, { query: { limit: 1 } })
    if (res.status === 401) throw new Error('Falcon API client rejected (401) — check the client secret')
    if (res.status === 403) {
      throw new Error('Falcon API client lacks the "Cloud Security Policies: Read" scope (403)')
    }
    if (!res.ok) throw new Error(falconErrorMessage(res))
    return `Falcon Cloud Security API reachable at ${baseUrl}`
  })
  checks.push(reachable)

  // Check 2..n: each declared control exists
  if (reachable.passed) {
    const specs = extractControlSpecs(ctx.canvas).filter((s) => s.name && s.frameworkId && s.section)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`control:${spec.name}`, async () => {
          const live = await findControl(client, {
            name: spec.name,
            frameworkId: spec.frameworkId,
            section: spec.section,
          })
          if (!live) {
            throw new Error(`Control "${spec.name}" in section "${spec.section}" does not exist in the tenant`)
          }
          return `Control "${spec.name}" is present`
        }),
      )
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)

  return { healthy: passedCount === checks.length, score, checks }
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
