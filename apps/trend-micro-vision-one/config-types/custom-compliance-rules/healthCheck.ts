import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildVisionOneClient } from '../../lib/visionOneApi'
import { CUSTOM_RULE_ENDPOINTS } from './_shared'

/**
 * Health for the custom-compliance-rules config = Trend Vision One answers on
 * its BETA API with the configured API key. Read-only:
 * GET beta/cloudPosture/customRules (top=1). A response below 500 counts as
 * reachable; 401/403 mean the key is bad or lacks Cloud Risk Management scope.
 * VERIFY the probe endpoint against a live Vision One tenant.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, settings } = ctx
  const checks: HealthCheck[] = []

  if (!credential) {
    checks.push({ name: 'credential', passed: false, message: 'No credential attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const built = buildVisionOneClient(component?.hostname, credential, settings)
  if ('error' in built) {
    checks.push({ name: 'credential', passed: false, message: built.error })
    return { healthy: false, score: 0, checks }
  }
  const { client } = built

  const started = Date.now()
  try {
    const res = await client.getBeta(`${CUSTOM_RULE_ENDPOINTS.list}?top=1`)
    const passed = res.status > 0 && res.status < 500
    checks.push({
      name: 'vision_one_reachable',
      passed,
      message: passed
        ? `Trend Vision One reachable (HTTP ${res.status}).`
        : `Trend Vision One returned HTTP ${res.status}.`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'vision_one_reachable',
      passed: false,
      message: `Trend Vision One unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
