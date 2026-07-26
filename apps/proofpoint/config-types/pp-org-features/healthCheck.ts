import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildPPClient } from '../../lib/proofpoint'
import { extractFeatureSpecs, getFeatures, readFeature } from './validate'

/**
 * Health check for feature configuration:
 *   1. Essentials API reachability + credential/org validity (read the features)
 *   2. Every declared feature is present in the org and matches its declared state
 * A feature absent from the org (not part of its licensing package) is a failed
 * check. Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildPPClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'pp_credential', passed: false, message: built.error }] }
  }
  const { client, orgDomain } = built

  const specs = extractFeatureSpecs(ctx.canvas).filter((s) => s.feature)

  const start = Date.now()
  let features: Record<string, unknown> | null = null
  try {
    features = await getFeatures(client)
    checks.push({ name: 'pp_reachable', passed: true, message: `Proofpoint Essentials reachable — org "${orgDomain}"`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({
      name: 'pp_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    })
  }

  if (features) {
    for (const spec of specs) {
      const current = readFeature(features, spec.feature)
      if (current === null) {
        checks.push({
          name: `feature:${spec.feature}`,
          passed: false,
          message: `Feature "${spec.feature}" is not available on this organization (check the licensing package)`,
        })
        continue
      }
      const matches = current === spec.enabled
      checks.push({
        name: `feature:${spec.feature}`,
        passed: matches,
        message: matches
          ? `Feature "${spec.feature}" is ${spec.enabled ? 'enabled' : 'disabled'} as declared`
          : `Feature "${spec.feature}" drifted (expected ${spec.enabled}, found ${current})`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
