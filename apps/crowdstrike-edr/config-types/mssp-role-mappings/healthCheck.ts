import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconErrorMessage } from '../../lib/falcon'
import { MSSP_ROLES_QUERY, getLiveRoles } from './deploy'
import { bindingLabel, extractRoleMappingSpecs } from './validate'

/**
 * Health check for MSSP role mapping configuration:
 *   1. Flight Control API reachability + credential validity (parent-CID + MSSP scope)
 *   2. Every declared binding exists with all its declared role ids granted
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
    const res = await client.request('GET', MSSP_ROLES_QUERY, { query: { limit: 1 } })
    if (res.status === 401) throw new Error('Falcon API client rejected (401) — check the client secret')
    if (res.status === 403) {
      throw new Error(
        'Falcon API client lacks the Flight Control (MSSP) scope, or the tenant is not an MSSP parent CID (403)',
      )
    }
    if (!res.ok) throw new Error(falconErrorMessage(res))
    return `Flight Control API reachable at ${baseUrl}`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractRoleMappingSpecs(ctx.canvas).filter((s) => s.userGroupId && s.cidGroupId)
    for (const spec of specs) {
      const label = bindingLabel(spec.userGroupId, spec.cidGroupId)
      checks.push(
        await timedCheck(`role-mapping:${label}`, async () => {
          const live = await getLiveRoles(client, spec.userGroupId, spec.cidGroupId)
          if (!live.exists) throw new Error(`Role mapping (${label}) does not exist in the tenant`)
          const missing = spec.roleIds.filter((role) => !live.roleIds.includes(role))
          if (missing.length > 0) {
            throw new Error(`Role mapping (${label}) is missing declared role(s): ${missing.join(', ')}`)
          }
          return `Role mapping (${label}) is present with all ${spec.roleIds.length} declared role(s)`
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
