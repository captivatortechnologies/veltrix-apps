import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconErrorMessage } from '../../lib/falcon'
import { findImagePolicyByName, IMAGE_POLICY_ENTITY } from './deploy'
import { extractImagePolicySpecs } from './validate'

/**
 * Health check for image assessment policy configuration:
 *   1. Falcon Cloud Security API reachability + credential validity
 *   2. Every declared policy exists with the declared enablement state
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

  // Check 1: API reachable and the client has the image-assessment-policies scope
  const reachable = await timedCheck('falcon_reachable', async () => {
    const res = await client.request('GET', IMAGE_POLICY_ENTITY)
    if (res.status === 401) throw new Error('Falcon API client rejected (401) — check the client secret')
    if (res.status === 403) {
      throw new Error('Falcon API client lacks the Falcon Container Image / image assessment policies scope (403)')
    }
    if (!res.ok) throw new Error(falconErrorMessage(res))
    return `Falcon Cloud Security API reachable at ${baseUrl}`
  })
  checks.push(reachable)

  // Check 2..n: each declared policy exists with the declared enablement
  if (reachable.passed) {
    const specs = extractImagePolicySpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`policy:${spec.name}`, async () => {
          const live = await findImagePolicyByName(client, spec.name)
          if (!live) {
            throw new Error(`Policy "${spec.name}" does not exist in the tenant`)
          }
          const liveEnabled = live.is_enabled === true
          if (liveEnabled !== spec.enabled) {
            throw new Error(
              `Policy "${spec.name}" is ${liveEnabled ? 'enabled' : 'disabled'} but should be ${
                spec.enabled ? 'enabled' : 'disabled'
              }`,
            )
          }
          return `Policy "${spec.name}" is present and ${spec.enabled ? 'enabled' : 'disabled'} as declared`
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
