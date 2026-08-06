import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { getApiKeyDetails, getNotificationsSettings } from '../../lib/gravityZoneApi'
import { extractNotificationSettingsSpecs } from './_shared'

/**
 * Health check for notification settings configuration:
 *   1. GravityZone API reachability + API key validity (general.getApiKeyDetails)
 *   2. Every declared accountId (or the API key's own account when blank)
 *      resolves via accounts.getNotificationsSettings
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'gravityzone_credential', passed: false, message: built.error }] }
  }
  const { client } = built

  const started = Date.now()
  try {
    await getApiKeyDetails(client)
    checks.push({ name: 'gravityzone_reachable', passed: true, message: 'GravityZone API reachable and API key accepted.', latencyMs: Date.now() - started })
  } catch (error) {
    checks.push({
      name: 'gravityzone_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'GravityZone API unreachable',
      latencyMs: Date.now() - started,
    })
    return { healthy: false, score: 0, checks }
  }

  const specs = extractNotificationSettingsSpecs(ctx.canvas)
  for (const spec of specs) {
    const label = spec.accountId || '(own account)'
    const checkStarted = Date.now()
    try {
      await getNotificationsSettings(client, spec.accountId || undefined)
      checks.push({ name: `notification-settings:${label}`, passed: true, message: `Notification settings for "${label}" resolved.`, latencyMs: Date.now() - checkStarted })
    } catch (error) {
      checks.push({
        name: `notification-settings:${label}`,
        passed: false,
        message: error instanceof Error ? error.message : `Notification settings for "${label}" could not be resolved.`,
        latencyMs: Date.now() - checkStarted,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
