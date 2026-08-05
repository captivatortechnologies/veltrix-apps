import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildTinesClient, tinesErrorMessage } from '../../lib/tinesApi'
import { extractTeamMemberSpecs, findMember } from './_shared'
import { listMembers } from './deploy'

/**
 * Health check for Team Members configuration:
 *   1. Tines API reachability + auth (GET /api/v1/teams answers 2xx)
 *   2. every declared (team, email) membership still exists
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
    const specs = extractTeamMemberSpecs(ctx.canvas).filter((s) => s.teamId && s.email)
    const cache = new Map<string, Awaited<ReturnType<typeof listMembers>>>()
    for (const spec of specs) {
      try {
        let members = cache.get(spec.teamId)
        if (!members) {
          members = await listMembers(client, spec.teamId)
          cache.set(spec.teamId, members)
        }
        const present = Boolean(findMember(members, spec.email))
        checks.push({
          name: `member:${spec.email}`,
          passed: present,
          message: present ? `"${spec.email}" is a member of team ${spec.teamId}.` : `"${spec.email}" is not a member of team ${spec.teamId}.`,
        })
      } catch (error) {
        checks.push({
          name: `member:${spec.email}`,
          passed: false,
          message: `Could not list members: ${error instanceof Error ? error.message : 'error'}`,
        })
      }
    }
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
