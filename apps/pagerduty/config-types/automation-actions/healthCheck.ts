import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildPagerDutyClient, pagerDutyErrorMessage } from '../../lib/pagerdutyApi'
import { extractAutomationActionSpecs, findAutomationAction } from './_shared'
import { listAutomationActions } from './deploy'

/**
 * Health check for automation-actions configuration:
 *   1. PagerDuty API reachability + auth (GET /abilities answers 2xx with the key)
 *   2. every declared action (by name) still exists in the account
 * Team/service association health is NOT checked here — that is driftDetect's
 * job; this check stays cheap, matching this app's other config types.
 * Score is the fraction of passed checks (0–1).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheck[] = []

  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'credential', passed: false, message: built.error }] }
  }
  const { client } = built

  const started = Date.now()
  let reachable = false
  try {
    const res = await client.request('GET', '/abilities')
    reachable = res.ok
    checks.push({
      name: 'pagerduty_reachable',
      passed: res.ok,
      message: res.ok ? `PagerDuty reachable (HTTP ${res.status}).` : `PagerDuty returned HTTP ${res.status}: ${pagerDutyErrorMessage(res)}`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'pagerduty_reachable',
      passed: false,
      message: `PagerDuty unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  if (reachable) {
    const specs = extractAutomationActionSpecs(ctx.canvas).filter((s) => s.name)
    if (specs.length > 0) {
      try {
        const live = await listAutomationActions(client)
        for (const spec of specs) {
          const present = Boolean(findAutomationAction(live, spec.name))
          checks.push({
            name: `automation_action:${spec.name}`,
            passed: present,
            message: present
              ? `Automation action "${spec.name}" is present.`
              : `Automation action "${spec.name}" is missing.`,
          })
        }
      } catch (error) {
        checks.push({
          name: 'automation_actions_readable',
          passed: false,
          message: `Could not list automation actions: ${error instanceof Error ? error.message : 'error'}`,
        })
      }
    }
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
