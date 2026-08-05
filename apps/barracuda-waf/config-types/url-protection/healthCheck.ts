import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient } from '../../lib/barracudaWaf'
import { extractUrlProtectionSpec, getUrlProtection } from './validate'

/**
 * Health check for URL Protection:
 *   1. Barracuda WAF-as-a-Service reachability + credential/Application validity
 *   2. The master `enabled` flag and `csrf_prevention` mode match the live value
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'barracuda_credential', passed: false, message: built.error }] }
  }
  const { client, appName } = built

  const spec = extractUrlProtectionSpec(ctx.canvas)
  const start = Date.now()

  try {
    const live = await getUrlProtection(client, appName)
    checks.push({ name: 'barracuda_reachable', passed: true, message: `Barracuda WAF-as-a-Service reachable — Application "${appName}"`, latencyMs: Date.now() - start })

    const enabledMatches = (live.enabled ?? false) === spec.enabled
    checks.push({
      name: 'enabled',
      passed: enabledMatches,
      message: enabledMatches ? `URL Protection enabled flag matches (${spec.enabled})` : `URL Protection enabled flag drifted (expected ${spec.enabled}, found ${live.enabled ?? false})`,
    })

    const csrfMatches = (live.csrf_prevention ?? '') === spec.csrfPrevention
    checks.push({
      name: 'csrf_prevention',
      passed: csrfMatches,
      message: csrfMatches
        ? `CSRF Prevention mode matches (${spec.csrfPrevention})`
        : `CSRF Prevention mode drifted (expected "${spec.csrfPrevention}", found "${live.csrf_prevention ?? 'not set'}")`,
    })
  } catch (error) {
    checks.push({
      name: 'barracuda_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    })
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
