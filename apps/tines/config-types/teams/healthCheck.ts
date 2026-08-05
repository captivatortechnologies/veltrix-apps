import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildTinesClient, tinesErrorMessage } from '../../lib/tinesApi'
import { extractTeamSpecs, findTeam } from './_shared'
import { listTeams } from './deploy'

/**
 * Health check for teams configuration:
 *   1. Tines API reachability + auth (GET /api/v1/teams answers 2xx with the key)
 *   2. every declared team (by name) still exists in the tenant
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheck[] = []

  const built = buildTinesClient(ctx.component?.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'credential', passed: false, message: built.error }] }
  }
  const { client } = built

  const started = Date.now()
  let reachable = false
  try {
    const res = await client.request('GET', '/teams', { query: { per_page: 1 } })
    reachable = res.ok
    checks.push({
      name: 'tines_reachable',
      passed: res.ok,
      message: res.ok ? `Tines reachable (HTTP ${res.status}).` : `Tines returned HTTP ${res.status}: ${tinesErrorMessage(res)}`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'tines_reachable',
      passed: false,
      message: `Tines unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  if (reachable) {
    const specs = extractTeamSpecs(ctx.canvas).filter((s) => s.name)
    if (specs.length > 0) {
      try {
        const live = await listTeams(client)
        for (const spec of specs) {
          const present = Boolean(findTeam(live, spec.name))
          checks.push({
            name: `team:${spec.name}`,
            passed: present,
            message: present ? `Team "${spec.name}" is present.` : `Team "${spec.name}" is missing.`,
          })
        }
      } catch (error) {
        checks.push({
          name: 'teams_readable',
          passed: false,
          message: `Could not list teams: ${error instanceof Error ? error.message : 'error'}`,
        })
      }
    }
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
