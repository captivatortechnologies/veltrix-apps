import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCheckpointClient } from '../../lib/checkpointApi'
import { listAllGroups } from './deploy'
import { extractGroupSpecs, groupKey, type LiveGroup } from './validate'

/**
 * Health check for Check Point network-groups configuration:
 *   1. Management API reachability + credential validity (login + show-groups)
 *   2. Every declared group (by name) still exists in the management database
 * Logs out at the end without publishing or discarding — read-only. Score is
 * the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildCheckpointClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'checkpoint_credential', passed: false, message: built.error }] }
  }
  const { client, host } = built

  const started = Date.now()
  const login = await client.login()
  if (login.error) {
    return { healthy: false, score: 0, checks: [{ name: 'checkpoint_login', passed: false, message: login.error }] }
  }

  const specs = extractGroupSpecs(ctx.canvas).filter((s) => s.name)
  let live: LiveGroup[] = []

  try {
    live = await listAllGroups(client)
    checks.push({
      name: 'checkpoint_reachable',
      passed: true,
      message: `Reached the Check Point Management API at ${host}`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'checkpoint_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'show-groups failed',
      latencyMs: Date.now() - started,
    })
  } finally {
    await client.logout()
  }

  if (live.length > 0 || checks[0]?.passed) {
    const names = new Set(live.filter((g) => g.name).map((g) => groupKey(g.name as string)))
    for (const spec of specs) {
      const present = names.has(groupKey(spec.name))
      checks.push({
        name: `group:${spec.name}`,
        passed: present,
        message: present ? `Group "${spec.name}" is present` : `Group "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
