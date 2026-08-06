import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildOnePasswordClient, scimErrorMessage } from '../../lib/onePassword'
import { listUsers } from './deploy'
import { extractUserSpecs, type LiveUser } from './validate'

/**
 * Health check for user configuration:
 *   1. SCIM Bridge reachability + bearer token validity (GET /Users)
 *   2. Every declared user still exists, matched by userName, and is in the
 *      expected active/suspended state
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildOnePasswordClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'onepassword_credential', passed: false, message: built.error }] }
  }
  const { client, baseUrl } = built

  let users: LiveUser[] = []
  const reachable = await timedCheck('onepassword_reachable', async () => {
    const res = await client.request('GET', '/Users', { query: { count: 1 } })
    if (res.status === 401 || res.status === 403) {
      throw new Error('The SCIM Bridge rejected the bearer token')
    }
    if (!res.ok) throw new Error(scimErrorMessage(res))
    users = await listUsers(client)
    return `1Password SCIM Bridge ${baseUrl} reachable`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractUserSpecs(ctx.canvas).filter((s) => s.userName)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`user:${spec.userName}`, async () => {
          const live = users.find((u) => (u.userName ?? '').toLowerCase() === spec.userName.toLowerCase())
          if (!live) throw new Error(`User "${spec.userName}" does not exist on the bridge`)
          const liveActive = live.active !== false
          if (liveActive !== spec.active) {
            throw new Error(`User "${spec.userName}" is ${liveActive ? 'active' : 'suspended'}, expected ${spec.active ? 'active' : 'suspended'}`)
          }
          return `User "${spec.userName}" is present and ${spec.active ? 'active' : 'suspended'} as expected`
        }),
      )
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

async function timedCheck(name: string, fn: () => Promise<string>): Promise<HealthCheckResult['checks'][0]> {
  const start = Date.now()
  try {
    const message = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start }
  } catch (error) {
    return { name, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start }
  }
}
