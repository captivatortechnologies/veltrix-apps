import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient, jumpCloudErrorMessage } from '../../lib/jumpcloudApi'
import { listSoftwareApps } from './deploy'
import { extractSoftwareAppSpecs, findSoftwareAppByName, type JumpCloudSoftwareApp } from './_shared'

/**
 * Health check for Software App configuration:
 *   1. JumpCloud API reachability + key validity (GET /softwareapps — a
 *      401/403 means the API key was rejected).
 *   2. Every declared app still exists in the org (matched by displayName).
 * Score is the fraction of passed checks.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheck[] = []

  const built = buildJumpCloudClient(ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'credential', passed: false, message: built.error }] }
  }
  const { client } = built

  let liveApps: JumpCloudSoftwareApp[] = []
  let reachable = false
  const started = Date.now()
  try {
    const res = await client.request('GET', '/softwareapps', { query: { limit: 1 } })
    if (res.status === 401 || res.status === 403) {
      throw new Error(`JumpCloud rejected the API key (HTTP ${res.status}).`)
    }
    if (!res.ok) throw new Error(jumpCloudErrorMessage(res))
    reachable = true
    liveApps = await listSoftwareApps(client)
    checks.push({ name: 'jumpcloud_reachable', passed: true, message: 'JumpCloud API reachable and the API key is accepted.', latencyMs: Date.now() - started })
  } catch (error) {
    checks.push({
      name: 'jumpcloud_reachable',
      passed: false,
      message: `JumpCloud unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  if (reachable) {
    for (const spec of extractSoftwareAppSpecs(ctx.canvas).filter((s) => s.displayName)) {
      const live = findSoftwareAppByName(liveApps, spec.displayName)
      checks.push({
        name: `software_app:${spec.displayName}`,
        passed: Boolean(live),
        message: live ? `Software App "${spec.displayName}" is present.` : `Software App "${spec.displayName}" was not found in the org.`,
      })
    }
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
