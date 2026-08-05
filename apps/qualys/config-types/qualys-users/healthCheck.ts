import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildQualysClient } from '../../lib/qualys'
import { listUsers } from './deploy'
import { extractUserSpecs, userKey, type LiveUser } from './validate'

/**
 * Health check for user account configuration:
 *   1. Qualys platform reachability + credential validity (a user list)
 *   2. Every declared user still exists (by email)
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'qualys_credential', passed: false, message: built.error }] }
  }
  const { client, platformUrl } = built

  const start = Date.now()
  let live: LiveUser[] | null = null
  try {
    live = await listUsers(client)
    checks.push({
      name: 'qualys_reachable',
      passed: true,
      message: `Qualys platform reachable at ${platformUrl}`,
      latencyMs: Date.now() - start,
    })
  } catch (error) {
    checks.push({
      name: 'qualys_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    })
  }

  if (live) {
    const keys = new Set(live.map((u) => userKey(u)))
    for (const spec of extractUserSpecs(ctx.canvas).filter((s) => s.email)) {
      const present = keys.has(userKey(spec))
      checks.push({
        name: `user:${spec.email}`,
        passed: present,
        message: present ? `User "${spec.email}" is present` : `User "${spec.email}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
