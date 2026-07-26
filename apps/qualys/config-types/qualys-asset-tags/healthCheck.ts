import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildQualysClient } from '../../lib/qualys'
import { listAssetTags } from './deploy'
import { assetTagKey, extractAssetTagSpecs, type LiveAssetTag } from './validate'

/**
 * Health check for asset tag configuration:
 *   1. Qualys platform reachability + credential validity (a tag search)
 *   2. Every declared tag still exists
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
  let live: LiveAssetTag[] | null = null
  try {
    live = await listAssetTags(client)
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
    const keys = new Set(live.map((t) => assetTagKey(t)))
    for (const spec of extractAssetTagSpecs(ctx.canvas).filter((s) => s.name)) {
      const present = keys.has(assetTagKey(spec))
      checks.push({
        name: `asset_tag:${spec.name}`,
        passed: present,
        message: present ? `Asset tag "${spec.name}" is present` : `Asset tag "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
