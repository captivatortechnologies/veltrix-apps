import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient } from '../../lib/insightvm'
import { listAssetGroups } from './deploy'
import { assetGroupKey, extractAssetGroupSpecs } from './validate'

/**
 * Health check for asset group configuration:
 *   1. InsightVM console reachability + credential validity (a paged /asset_groups list)
 *   2. Every declared asset group still exists
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
  let live: import('./validate').LiveAssetGroup[] | null = null
  try {
    live = await listAssetGroups(client)
    checks.push({ name: 'insightvm_reachable', passed: true, message: `InsightVM console reachable at ${consoleUrl}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'insightvm_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const keys = new Set(live.filter((g) => g.name).map((g) => assetGroupKey({ name: g.name as string })))
    for (const spec of extractAssetGroupSpecs(ctx.canvas).filter((s) => s.name && s.type)) {
      const present = keys.has(assetGroupKey(spec))
      checks.push({
        name: `asset_group:${spec.name}`,
        passed: present,
        message: present ? `Asset group "${spec.name}" is present` : `Asset group "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
