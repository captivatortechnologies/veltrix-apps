// =============================================================================
// Health check: is the Graph detection-rules API reachable, and is each declared
// rule still present? Score is the percentage of checks that passed.
// =============================================================================

import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildMdeClient } from '../../lib/mde'
import { listRules } from './deploy'
import { extractDetectionRuleSpecs, ruleKey, type LiveRule } from './validate'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []
  const built = buildMdeClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'mde_credential', passed: false, message: built.error }] }
  }
  const { client } = built

  if (!client.graphAvailable) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'graph_available', passed: false, message: 'Custom detection rules require Microsoft Graph, which is only available in the commercial cloud.' }],
    }
  }

  const start = Date.now()
  let live: LiveRule[] | null = null
  try {
    live = await listRules(client)
    checks.push({ name: 'graph_reachable', passed: true, message: 'Microsoft Graph detection rules API reachable', latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'graph_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const keys = new Set(live.filter((r) => r.id).map((r) => ruleKey(r.id as string)))
    for (const spec of extractDetectionRuleSpecs(ctx.canvas).filter((s) => s.ruleId)) {
      const present = keys.has(ruleKey(spec.ruleId))
      checks.push({
        name: `rule:${spec.ruleId}`,
        passed: present,
        message: present ? 'Detection rule is present' : 'Detection rule is missing',
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
