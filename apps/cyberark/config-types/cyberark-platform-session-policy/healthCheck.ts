import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCyberArkClient } from '../../lib/cyberark'
import { getSessionPolicy } from './deploy'
import { extractSessionPolicySpecs } from './validate'

/**
 * Health check for platform session-policy configuration: every declared
 * platform's GET succeeds and its PSM server matches the desired value.
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildCyberArkClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'cyberark_credential', passed: false, message: built.error }] }
  }
  const { client, pvwaUrl } = built

  const specs = extractSessionPolicySpecs(ctx.canvas).filter((s) => s.platformId)
  let reachedOne = false

  for (const spec of specs) {
    const start = Date.now()
    try {
      const live = await getSessionPolicy(client, spec.platformId)
      reachedOne = true
      const matches = !spec.psmServerId || spec.psmServerId === (live.PSMServerId ?? '')
      checks.push({
        name: `platform:${spec.platformId}`,
        passed: matches,
        message: matches ? `Platform "${spec.platformId}" session policy matches` : `Platform "${spec.platformId}" PSM server is "${live.PSMServerId ?? 'not set'}", expected "${spec.psmServerId}"`,
        latencyMs: Date.now() - start,
      })
    } catch (error) {
      checks.push({ name: `platform:${spec.platformId}`, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
    }
  }

  if (reachedOne) checks.unshift({ name: 'cyberark_reachable', passed: true, message: `PVWA reachable at ${pvwaUrl}` })
  else if (specs.length > 0) checks.unshift({ name: 'cyberark_reachable', passed: false, message: `Could not reach PVWA at ${pvwaUrl}` })

  await client.logoff()
  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 0
  return { healthy: passedCount === checks.length, score, checks }
}
