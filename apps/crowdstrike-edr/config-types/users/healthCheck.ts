import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconErrorMessage, sameSet } from '../../lib/falcon'
import { findUserByEmail, getUserRoleIds } from './deploy'
import { extractUserSpecs } from './validate'

/**
 * Health check for user configuration:
 *   1. Falcon API reachability + credential validity (User Management scope)
 *   2. Every declared user exists, with the declared direct roles when managed
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

  // Check 1: API reachable and the client has the User Management scope
  const reachable = await timedCheck('falcon_reachable', async () => {
    const res = await client.request('GET', '/user-management/queries/users/v1', {
      query: { limit: 1 },
    })
    if (res.status === 401) throw new Error('Falcon API client rejected (401) — check the client secret')
    if (res.status === 403) {
      throw new Error('Falcon API client lacks the "User Management: Read" scope (403)')
    }
    if (!res.ok) throw new Error(falconErrorMessage(res))
    return `Falcon API reachable at ${baseUrl}`
  })
  checks.push(reachable)

  // Check 2..n: each declared user exists (and holds its declared roles)
  if (reachable.passed) {
    const specs = extractUserSpecs(ctx.canvas).filter((s) => s.email)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`user:${spec.email}`, async () => {
          const live = await findUserByEmail(client, spec.email)
          if (!live?.uuid) {
            throw new Error(`User "${spec.email}" does not exist in the tenant`)
          }
          if (spec.manageRoles) {
            const liveRoles = await getUserRoleIds(client, live.uuid)
            if (!sameSet(liveRoles, spec.roleIds)) {
              throw new Error(
                `User "${spec.email}" roles differ — expected [${spec.roleIds.join(', ')}], found [${liveRoles.join(', ')}]`,
              )
            }
            return `User "${spec.email}" is present with the declared roles`
          }
          return `User "${spec.email}" is present`
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
