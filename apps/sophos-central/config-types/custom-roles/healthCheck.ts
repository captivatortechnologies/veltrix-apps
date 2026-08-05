import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { checkSophosReachable, buildSophosClient } from '../../lib/sophosCentral'
import { listRoles } from '../../lib/sophosApi'
import { customRoleKey, extractCustomRoleSpecs } from './_shared'

/**
 * Health check for custom role configuration:
 *   1. Sophos Central API reachability + service principal validity
 *   2. Every declared role name still exists as a live role
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildSophosClient(ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'sophos_credential', passed: false, message: built.error }] }
  }
  const { client } = built

  const reachability = await checkSophosReachable(client)
  checks.push(reachability)
  if (!reachability.passed) return { healthy: false, score: 0, checks }

  const specs = extractCustomRoleSpecs(ctx.canvas).filter((s) => s.name)
  const started = Date.now()
  try {
    const live = await listRoles(client)
    const liveNames = new Set(live.filter((r) => r.name).map((r) => customRoleKey(r.name)))
    for (const spec of specs) {
      const present = liveNames.has(customRoleKey(spec.name))
      checks.push({
        name: `role:${spec.name}`,
        passed: present,
        message: present ? `Role "${spec.name}" is present.` : `Role "${spec.name}" is missing.`,
        latencyMs: Date.now() - started,
      })
    }
  } catch (error) {
    checks.push({
      name: 'roles:list',
      passed: false,
      message: error instanceof Error ? error.message : 'Failed to list roles',
      latencyMs: Date.now() - started,
    })
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
