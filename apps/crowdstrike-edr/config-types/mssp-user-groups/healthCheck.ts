import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconErrorMessage } from '../../lib/falcon'
import { USER_GROUPS_QUERY, findUserGroup, getUserGroupMembers, userGroupIdOf } from './deploy'
import { extractUserGroupSpecs } from './validate'

/**
 * Health check for MSSP user group configuration:
 *   1. Flight Control API reachability + credential validity (parent-CID + MSSP scope)
 *   2. Every declared group exists with all its declared member UUIDs present
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
    const res = await client.request('GET', USER_GROUPS_QUERY, { query: { limit: 1 } })
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
    const specs = extractUserGroupSpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`user-group:${spec.name}`, async () => {
          const live = await findUserGroup(client, spec.name)
          if (!live) throw new Error(`User group "${spec.name}" does not exist in the tenant`)
          const id = userGroupIdOf(live)
          const liveUuids = id ? await getUserGroupMembers(client, id) : []
          const missing = spec.userUuids.filter((uuid) => !liveUuids.includes(uuid))
          if (missing.length > 0) {
            throw new Error(`User group "${spec.name}" is missing member user(s): ${missing.join(', ')}`)
          }
          return `User group "${spec.name}" is present with all ${spec.userUuids.length} declared member(s)`
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
