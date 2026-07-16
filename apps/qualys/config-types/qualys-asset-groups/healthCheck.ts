import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildQualysClient } from '../../lib/qualys'
import { listAssetGroups } from './deploy'
import { assetGroupKey, extractAssetGroupSpecs, type LiveAssetGroup } from './validate'

/**
 * Health check for asset group configuration:
 *   1. Qualys platform reachability + credential validity (a paged asset-group list)
 *   2. Every declared asset group still exists
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
  let live: LiveAssetGroup[] | null = null
  try {
    live = await listAssetGroups(client)
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
    const keys = new Set(live.map((g) => assetGroupKey(g)))
    for (const spec of extractAssetGroupSpecs(ctx.canvas).filter((s) => s.title)) {
      const present = keys.has(assetGroupKey(spec))
      checks.push({
        name: `asset_group:${spec.title}`,
        passed: present,
        message: present ? `Asset group "${spec.title}" is present` : `Asset group "${spec.title}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
