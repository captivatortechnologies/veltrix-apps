import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildS1Client, MISSING_SCOPE_MESSAGE } from '../../lib/s1'
import { listStarRules } from './deploy'
import { extractStarRuleSpecs, ruleKey, type LiveStarRule } from './validate'

/**
 * Health check for STAR rule configuration:
 *   1. SentinelOne API reachability + credential/scope validity (a scoped list)
 *   2. Every declared rule (by name) still exists at the scope
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildS1Client(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 's1_credential', passed: false, message: built.error }] }
  }
  const { client, consoleUrl } = built
  if (!client.hasScope) {
    return { healthy: false, score: 0, checks: [{ name: 's1_scope', passed: false, message: MISSING_SCOPE_MESSAGE }] }
  }

  const specs = extractStarRuleSpecs(ctx.canvas).filter((s) => s.name && s.s1ql)

  const reachable = await timedCheck('s1_reachable', async () => {
    const live = await listStarRules(client)
    return { message: `SentinelOne reachable at ${consoleUrl} (${client.currentScope} scope)`, live }
  })
  checks.push({ name: reachable.name, passed: reachable.passed, message: reachable.message, latencyMs: reachable.latencyMs })

  if (reachable.passed && reachable.live) {
    const names = new Set(reachable.live.filter((r) => r.name).map((r) => ruleKey(r.name as string)))
    for (const spec of specs) {
      const present = names.has(ruleKey(spec.name))
      checks.push({
        name: `rule:${spec.name}`,
        passed: present,
        message: present ? `Rule "${spec.name}" is present` : `Rule "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

async function timedCheck(
  name: string,
  fn: () => Promise<{ message: string; live?: LiveStarRule[] }>,
): Promise<{ name: string; passed: boolean; message: string; latencyMs: number; live?: LiveStarRule[] }> {
  const start = Date.now()
  try {
    const { message, live } = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start, live }
  } catch (error) {
    return { name, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start }
  }
}
