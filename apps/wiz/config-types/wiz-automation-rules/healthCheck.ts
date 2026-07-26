import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildWizClient } from '../../lib/wiz'
import { listAutomationRules } from './deploy'
import { extractAutomationRuleSpecs, ruleKey, type LiveAutomationRule } from './validate'

/**
 * Health check for automation-rule configuration:
 *   1. Wiz GraphQL reachability + credential validity (an automation-rule list)
 *   2. Every declared rule (by name) still exists in the tenant
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildWizClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'wiz_credential', passed: false, message: built.error }] }
  }
  const { client, graphqlUrl } = built

  const specs = extractAutomationRuleSpecs(ctx.canvas).filter((s) => s.name && s.integrationId && s.actionTemplateType)

  const reachable = await timedCheck('wiz_reachable', async () => {
    const live = await listAutomationRules(client)
    return { message: `Wiz reachable at ${graphqlUrl}`, live }
  })
  checks.push({ name: reachable.name, passed: reachable.passed, message: reachable.message, latencyMs: reachable.latencyMs })

  if (reachable.passed && reachable.live) {
    const names = new Set(reachable.live.filter((r) => r.name).map((r) => ruleKey(r.name as string)))
    for (const spec of specs) {
      const present = names.has(ruleKey(spec.name))
      checks.push({
        name: `rule:${spec.name}`,
        passed: present,
        message: present ? `Automation rule "${spec.name}" is present` : `Automation rule "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

async function timedCheck(
  name: string,
  fn: () => Promise<{ message: string; live?: LiveAutomationRule[] }>,
): Promise<{ name: string; passed: boolean; message: string; latencyMs: number; live?: LiveAutomationRule[] }> {
  const start = Date.now()
  try {
    const { message, live } = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start, live }
  } catch (error) {
    return { name, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start }
  }
}
