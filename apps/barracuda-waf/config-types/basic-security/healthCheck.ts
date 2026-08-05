import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient } from '../../lib/barracudaWaf'
import { extractBasicSecuritySpec, getBasicSecurity } from './validate'

/**
 * Health check for Basic Security:
 *   1. Barracuda WAF-as-a-Service reachability + credential/Application validity
 *   2. The declared protection_mode matches the live value
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'barracuda_credential', passed: false, message: built.error }] }
  }
  const { client, appName } = built

  const spec = extractBasicSecuritySpec(ctx.canvas)
  const start = Date.now()

  try {
    const live = await getBasicSecurity(client, appName)
    checks.push({ name: 'barracuda_reachable', passed: true, message: `Barracuda WAF-as-a-Service reachable — Application "${appName}"`, latencyMs: Date.now() - start })

    const matches = (live.protection_mode ?? '') === spec.protectionMode
    checks.push({
      name: 'protection_mode',
      passed: matches,
      message: matches
        ? `Protection mode matches the declared configuration (${spec.protectionMode})`
        : `Protection mode drifted (expected "${spec.protectionMode}", found "${live.protection_mode ?? 'not set'}")`,
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
