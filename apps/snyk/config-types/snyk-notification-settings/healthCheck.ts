import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient } from '../../lib/snyk'
import { readNotificationSettings } from './deploy'
import { extractNotificationSpec } from './validate'

/**
 * Health check for notification settings:
 *   1. Snyk API reachability + token/org validity (a settings GET)
 *   2. The live new-issues-remediations.enabled matches the declared value
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

  const spec = extractNotificationSpec(ctx.canvas)
  const start = Date.now()
  try {
    const live = await readNotificationSettings(client)
    checks.push({ name: 'snyk_reachable', passed: true, message: `Snyk API reachable at ${host}`, latencyMs: Date.now() - start })
    const liveEnabled = live?.['new-issues-remediations']?.enabled ?? false
    const matches = liveEnabled === spec.newIssuesEnabled
    checks.push({
      name: 'new_issues_enabled',
      passed: matches,
      message: matches
        ? `New-issue notifications are ${spec.newIssuesEnabled ? 'enabled' : 'disabled'} as configured`
        : `New-issue notifications are ${liveEnabled ? 'enabled' : 'disabled'} but configuration expects ${spec.newIssuesEnabled ? 'enabled' : 'disabled'}`,
    })
  } catch (error) {
    checks.push({ name: 'snyk_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
