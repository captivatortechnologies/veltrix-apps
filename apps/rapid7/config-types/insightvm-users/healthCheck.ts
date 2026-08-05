import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient } from '../../lib/insightvm'
import { listUsers } from './deploy'
import { extractUserSpecs, userKey, type LiveUser } from './validate'

/**
 * Health check for user configuration:
 *   1. InsightVM console reachability + credential validity (a paged /users list)
 *   2. Every declared user (by login) still exists and is enabled
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'insightvm_credential', passed: false, message: built.error }] }
  }
  const { client, consoleUrl } = built

  const start = Date.now()
  let live: LiveUser[] | null = null
  try {
    live = await listUsers(client)
    checks.push({ name: 'insightvm_reachable', passed: true, message: `InsightVM console reachable at ${consoleUrl}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'insightvm_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const byKey = new Map(live.filter((u) => u.login).map((u) => [userKey({ login: u.login as string }), u]))
    for (const spec of extractUserSpecs(ctx.canvas).filter((s) => s.login && s.name && s.roleId)) {
      const found = byKey.get(userKey(spec))
      const present = Boolean(found)
      const enabledAsExpected = !found || Boolean(found.enabled) === spec.enabled
      checks.push({
        name: `user:${spec.login}`,
        passed: present && enabledAsExpected,
        message: !present
          ? `User "${spec.login}" is missing`
          : !enabledAsExpected
            ? `User "${spec.login}" enabled state does not match the declared configuration`
            : `User "${spec.login}" is present`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
