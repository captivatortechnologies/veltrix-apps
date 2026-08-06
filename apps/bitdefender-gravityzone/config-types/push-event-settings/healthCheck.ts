import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { getApiKeyDetails, getPushEventSettings } from '../../lib/gravityZoneApi'
import { extractPushEventSettingsSpec } from './_shared'

/**
 * Health check for the push event settings singleton:
 *   1. GravityZone API reachability + API key validity (general.getApiKeyDetails)
 *   2. push.getPushEventSettings succeeds and its status matches the declared status
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

  const spec = extractPushEventSettingsSpec(ctx.canvas)
  if (spec) {
    const checkStarted = Date.now()
    try {
      const live = await getPushEventSettings(client)
      const matches = live.status === spec.status
      checks.push({
        name: 'push-event-settings:status',
        passed: matches,
        message: matches
          ? 'Push event settings status matches the declared configuration.'
          : `Live status (${live.status}) does not match the declared status (${spec.status}).`,
        latencyMs: Date.now() - checkStarted,
      })
    } catch (error) {
      checks.push({
        name: 'push-event-settings:status',
        passed: false,
        message: error instanceof Error ? error.message : 'Failed to read push event settings',
        latencyMs: Date.now() - checkStarted,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
