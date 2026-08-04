import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient, secretServerErrorMessage } from '../../lib/secretServerApi'
import { extractUserSpecs, searchUsers, findUserByUsername } from './_shared'

/**
 * Health for users config:
 *   1. Secret Server reachability + OAuth2 logon (GET /api/v1/users?take=1)
 *   2. Every declared user (by username) still exists
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheck[] = []

  const built = buildSecretServerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'credential', passed: false, message: built.error }] }
  }
  const { client, apiBase } = built

  const started = Date.now()
  let reachable = false
  try {
    const res = await client.request('GET', '/users', { query: { take: 1 } })
    reachable = res.ok
    checks.push({
      name: 'secretserver_reachable',
      passed: res.ok,
      message: res.ok ? `Secret Server reachable at ${apiBase}` : `Secret Server returned HTTP ${res.status}: ${secretServerErrorMessage(res)}`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'secretserver_reachable',
      passed: false,
      message: `Secret Server unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  if (reachable) {
    const specs = extractUserSpecs(ctx.canvas.items ?? ctx.canvas.sections ?? []).filter((s) => s.username)
    for (const spec of specs) {
      try {
        const matches = await searchUsers(client, spec.username)
        const present = findUserByUsername(matches, spec.username) !== null
        checks.push({
          name: `user:${spec.username}`,
          passed: present,
          message: present ? `User "${spec.username}" is present` : `User "${spec.username}" is missing`,
        })
      } catch (error) {
        checks.push({ name: `user:${spec.username}`, passed: false, message: error instanceof Error ? error.message : 'check failed' })
      }
    }
  }

  const passed = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passed / checks.length) * 100) : 0
  return { healthy: passed === checks.length, score, checks }
}
