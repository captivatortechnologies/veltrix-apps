import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildOneLoginClient, oneLoginErrorMessage } from '../../lib/oneLogin'
import { listRoles } from './deploy'
import { extractRoleSpecs, type LiveRole } from './validate'

/**
 * Health check for role configuration:
 *   1. OneLogin account reachability + API credential validity (GET
 *      /api/2/roles)
 *   2. Every declared role still exists, matched by name
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildOneLoginClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'onelogin_credential', passed: false, message: built.error }] }
  }
  const { client, domain } = built

  let roles: LiveRole[] = []
  const reachable = await timedCheck('onelogin_reachable', async () => {
    const res = await client.request('GET', '/api/2/roles', { query: { limit: 1 } })
    if (res.status === 401 || res.status === 403) {
      throw new Error('OneLogin rejected the API credentials (invalid client id/secret, or missing scope)')
    }
    if (!res.ok) throw new Error(oneLoginErrorMessage(res))
    roles = await listRoles(client)
    return `OneLogin account ${domain} reachable`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractRoleSpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`role:${spec.name}`, async () => {
          const live = roles.find((r) => r.name === spec.name)
          if (!live) throw new Error(`Role "${spec.name}" does not exist in the account`)
          return `Role "${spec.name}" is present`
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
