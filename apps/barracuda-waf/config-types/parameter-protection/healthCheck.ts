import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient } from '../../lib/barracudaWaf'
import { extractParameterProtectionSpec, getParameterProtection } from './validate'

/**
 * Health check for Parameter Protection:
 *   1. Barracuda WAF-as-a-Service reachability + credential/Application validity
 *   2. The master `enabled` flag and maximum parameter value length match the live value
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'barracuda_credential', passed: false, message: built.error }] }
  }
  const { client, appName } = built

  const spec = extractParameterProtectionSpec(ctx.canvas)
  const start = Date.now()

  try {
    const live = await getParameterProtection(client, appName)
    checks.push({ name: 'barracuda_reachable', passed: true, message: `Barracuda WAF-as-a-Service reachable — Application "${appName}"`, latencyMs: Date.now() - start })

    const enabledMatches = (live.enabled ?? false) === spec.enabled
    checks.push({
      name: 'enabled',
      passed: enabledMatches,
      message: enabledMatches ? `Parameter Protection enabled flag matches (${spec.enabled})` : `Parameter Protection enabled flag drifted (expected ${spec.enabled}, found ${live.enabled ?? false})`,
    })

    const lengthMatches = (live.maximum_parameter_value_length ?? null) === spec.maximumParameterValueLength
    checks.push({
      name: 'maximum_parameter_value_length',
      passed: lengthMatches,
      message: lengthMatches
        ? 'Maximum Parameter Value Length matches the declared configuration'
        : `Maximum Parameter Value Length drifted (expected ${spec.maximumParameterValueLength}, found ${live.maximum_parameter_value_length ?? 'not set'})`,
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
