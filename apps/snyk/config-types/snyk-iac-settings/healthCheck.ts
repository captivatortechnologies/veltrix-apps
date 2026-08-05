import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient } from '../../lib/snyk'
import { readIacCustomRules } from './deploy'
import { buildCustomRulesAttributes, extractIacSettings } from './validate'

/**
 * Health check for IaC settings:
 *   1. Snyk API reachability + token/org validity (a settings GET)
 *   2. The live `is_enabled` matches the declared value
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'snyk_credential', passed: false, message: built.error }] }
  }
  const { client, host } = built
  if (!client.hasOrg) {
    return { healthy: false, score: 0, checks: [{ name: 'snyk_org', passed: false, message: 'No Snyk organization id set' }] }
  }

  const spec = extractIacSettings(ctx.canvas)
  const desired = buildCustomRulesAttributes(spec)
  const start = Date.now()
  try {
    const live = (await readIacCustomRules(client)) ?? {}
    checks.push({ name: 'snyk_reachable', passed: true, message: `Snyk API reachable at ${host}`, latencyMs: Date.now() - start })
    const matches = Boolean(desired.is_enabled) === Boolean(live.is_enabled)
    checks.push({
      name: 'iac_custom_rules_enabled',
      passed: matches,
      message: matches
        ? `IaC custom rules are ${spec.isEnabled ? 'enabled' : 'disabled'} as configured`
        : `IaC custom rules are ${live.is_enabled ? 'enabled' : 'disabled'} but configuration expects ${spec.isEnabled ? 'enabled' : 'disabled'}`,
    })
  } catch (error) {
    checks.push({ name: 'snyk_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
