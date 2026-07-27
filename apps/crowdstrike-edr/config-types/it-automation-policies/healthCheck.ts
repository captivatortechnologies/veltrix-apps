import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconErrorMessage } from '../../lib/falcon'
import { findEntityByIdentity } from '../../lib/entityAdapter'
import { IT_POLICY_ENDPOINTS } from './deploy'
import { extractITPolicySpecs, readLiveEnabled, type LiveITPolicy } from './validate'

/**
 * Health check for IT automation policy configuration:
 *   1. Falcon API reachability + credential validity (IT automation scope)
 *   2. Every declared policy exists on the tenant, and — when the live policy
 *      exposes enablement — matches the declared state.
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

  const reachable = await timedCheck('falcon_reachable', async () => {
    const res = await client.request('GET', IT_POLICY_ENDPOINTS.queries, { query: { limit: 1 } })
    if (res.status === 401) throw new Error('Falcon API client rejected (401) — check the client secret')
    if (res.status === 403) {
      throw new Error('Falcon API client lacks the "IT automation policies: Read" scope (403)')
    }
    if (!res.ok) throw new Error(falconErrorMessage(res))
    return `Falcon API reachable at ${baseUrl}`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractITPolicySpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`policy:${spec.name}`, async () => {
          const live = (await findEntityByIdentity(
            client,
            IT_POLICY_ENDPOINTS,
            spec.name,
          )) as LiveITPolicy | null
          if (!live) {
            throw new Error(`Policy "${spec.name}" (${spec.platform}) does not exist in the tenant`)
          }
          const liveEnabled = readLiveEnabled(live)
          if (liveEnabled !== undefined && liveEnabled !== spec.enabled) {
            throw new Error(
              `Policy "${spec.name}" is ${liveEnabled ? 'enabled' : 'disabled'} but should be ${
                spec.enabled ? 'enabled' : 'disabled'
              }`,
            )
          }
          return `Policy "${spec.name}" is present and matches the declared enablement`
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
