import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildJumpCloudClient, jumpCloudErrorMessage, JUMPCLOUD_API_BASE } from '../../lib/jumpcloudApi'
import { listCommands } from './deploy'
import { extractCommandSpecs, findCommandByName, type JumpCloudCommand } from './_shared'

/**
 * Health check for Command configuration:
 *   1. JumpCloud API reachability + key validity (GET /commands — a 401/403
 *      means the API key was rejected).
 *   2. Every declared command still exists in the org (matched by name).
 * Score is the fraction of passed checks.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheck[] = []

  const built = buildJumpCloudClient(ctx.credential, ctx.settings, { baseUrl: JUMPCLOUD_API_BASE })
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'credential', passed: false, message: built.error }] }
  }
  const { client } = built

  let liveCommands: JumpCloudCommand[] = []
  let reachable = false
  const started = Date.now()
  try {
    const res = await client.request('GET', '/commands', { query: { limit: 1 } })
    if (res.status === 401 || res.status === 403) {
      throw new Error(`JumpCloud rejected the API key (HTTP ${res.status}).`)
    }
    if (!res.ok) throw new Error(jumpCloudErrorMessage(res))
    reachable = true
    liveCommands = await listCommands(client)
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
    for (const spec of extractCommandSpecs(ctx.canvas).filter((s) => s.name)) {
      const live = findCommandByName(liveCommands, spec.name)
      checks.push({
        name: `command:${spec.name}`,
        passed: Boolean(live),
        message: live ? `Command "${spec.name}" is present.` : `Command "${spec.name}" was not found in the org.`,
      })
    }
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
