import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient } from '../../lib/insightvm'
import { listOverrides } from './deploy'
import { extractOverrideSpecs, overrideKey, overrideLabel, liveOverrideKey, type LiveOverride } from './validate'

/**
 * Health check for policy-override configuration:
 *   1. InsightVM console reachability + credential validity (a paged list)
 *   2. Every declared override (rule, scope) still exists
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
  let live: LiveOverride[] | null = null
  try {
    live = await listOverrides(client)
    checks.push({ name: 'insightvm_reachable', passed: true, message: `InsightVM console reachable at ${consoleUrl}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'insightvm_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const keys = new Set<string>()
    for (const o of live) {
      const key = liveOverrideKey(o)
      if (key) keys.add(key)
    }
    for (const spec of extractOverrideSpecs(ctx.canvas).filter((s) => s.ruleId !== undefined && s.newResult)) {
      const label = overrideLabel(spec)
      const present = keys.has(overrideKey({ ruleId: spec.ruleId as number, scopeType: spec.scopeType, assetId: spec.assetId }))
      checks.push({
        name: `override:${label}`,
        passed: present,
        message: present ? `Policy override for ${label} is present` : `Policy override for ${label} is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
