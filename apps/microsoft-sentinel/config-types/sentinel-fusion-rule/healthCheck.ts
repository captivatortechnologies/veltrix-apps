import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient } from '../../lib/sentinel'
import { findFusionRule } from './deploy'
import { extractFusionRuleSpecs } from './validate'

/**
 * Health check for the Fusion rule:
 *   1. ARM reachability + token/permission validity (an alertRules list)
 *   2. The Fusion rule is present in the workspace (when declared)
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'sentinel_credential', passed: false, message: built.error }] }
  }
  const { client, armHost } = built

  const start = Date.now()
  let found: Awaited<ReturnType<typeof findFusionRule>> = null
  let reachable = false
  try {
    found = await findFusionRule(client)
    reachable = true
    checks.push({ name: 'arm_reachable', passed: true, message: `Azure Resource Manager reachable at ${armHost}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'arm_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (reachable && extractFusionRuleSpecs(ctx.canvas).length > 0) {
    const present = found != null
    checks.push({ name: 'fusion_rule', passed: present, message: present ? 'Fusion rule is present' : 'Fusion rule is missing' })
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
