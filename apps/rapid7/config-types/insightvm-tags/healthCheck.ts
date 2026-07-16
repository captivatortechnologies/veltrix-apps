import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient } from '../../lib/insightvm'
import { listTags } from './deploy'
import { extractTagSpecs, tagKey } from './validate'

/**
 * Health check for tag configuration:
 *   1. InsightVM console reachability + credential validity (a paged /tags list)
 *   2. Every declared tag (name, type) still exists
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
  let live: import('./validate').LiveTag[] | null = null
  try {
    live = await listTags(client)
    checks.push({ name: 'insightvm_reachable', passed: true, message: `InsightVM console reachable at ${consoleUrl}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'insightvm_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const keys = new Set(live.filter((t) => t.name && t.type).map((t) => tagKey({ name: t.name as string, type: t.type as string })))
    for (const spec of extractTagSpecs(ctx.canvas).filter((s) => s.name && s.type)) {
      const present = keys.has(tagKey(spec))
      checks.push({
        name: `tag:${spec.name} (${spec.type})`,
        passed: present,
        message: present ? `Tag "${spec.name}" is present` : `Tag "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
