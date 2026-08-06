import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { getApiKeyDetails, getCustomGroupsList } from '../../lib/gravityZoneApi'
import { extractNetworkGroupSpecs, findLiveGroup } from './_shared'

/**
 * Health check for network group configuration:
 *   1. GravityZone API reachability + API key validity (general.getApiKeyDetails)
 *   2. Every declared (groupName, parentId) still exists as a live group
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

  const specs = extractNetworkGroupSpecs(ctx.canvas).filter((s) => s.groupName)
  const liveByParent = new Map<string, Awaited<ReturnType<typeof getCustomGroupsList>>>()

  for (const spec of specs) {
    const parentKey = spec.parentId || '(root)'
    const checkStarted = Date.now()
    try {
      let live = liveByParent.get(parentKey)
      if (live === undefined) {
        live = await getCustomGroupsList(client, spec.parentId || undefined)
        liveByParent.set(parentKey, live)
      }
      const present = Boolean(findLiveGroup(live, spec.groupName))
      checks.push({
        name: `network-group:${spec.groupName}`,
        passed: present,
        message: present ? `Group "${spec.groupName}" is present.` : `Group "${spec.groupName}" is missing.`,
        latencyMs: Date.now() - checkStarted,
      })
    } catch (error) {
      checks.push({
        name: `network-group:${spec.groupName}`,
        passed: false,
        message: error instanceof Error ? error.message : 'Failed to list custom groups',
        latencyMs: Date.now() - checkStarted,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
