import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCheckpointClient } from '../../lib/checkpointApi'
import { listAllApplicationSites } from './deploy'
import { applicationSiteKey, extractApplicationSiteSpecs, type LiveApplicationSite } from './validate'

/**
 * Health check for Check Point application-sites configuration:
 *   1. Management API reachability + credential validity (login + show-application-sites)
 *   2. Every declared site (by name) still exists in the management database
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

  const specs = extractApplicationSiteSpecs(ctx.canvas).filter((s) => s.name)
  let live: LiveApplicationSite[] = []

  try {
    live = await listAllApplicationSites(client)
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
      message: error instanceof Error ? error.message : 'show-application-sites failed',
      latencyMs: Date.now() - started,
    })
  } finally {
    await client.logout()
  }

  if (live.length > 0 || checks[0]?.passed) {
    const names = new Set(live.filter((s) => s.name).map((s) => applicationSiteKey(s.name as string)))
    for (const spec of specs) {
      const present = names.has(applicationSiteKey(spec.name))
      checks.push({
        name: `application-site:${spec.name}`,
        passed: present,
        message: present ? `Application site "${spec.name}" is present` : `Application site "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
