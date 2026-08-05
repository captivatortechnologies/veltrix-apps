import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { checkSophosReachable, buildSophosClient } from '../../lib/sophosCentral'
import { listPolicies } from '../../lib/sophosApi'
import { extractPolicySpecs, policyKey } from './_shared'

/**
 * Health check for endpoint policy configuration:
 *   1. Sophos Central API reachability + service principal validity
 *   2. Every declared (name, type) pair still exists as a live policy
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

  const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.name && s.type)
  const started = Date.now()
  try {
    const live = await listPolicies(client)
    const liveKeys = new Set(live.filter((p) => p.name && p.type).map((p) => policyKey(p.name, p.type)))
    for (const spec of specs) {
      const label = `${spec.name} (${spec.type})`
      const present = liveKeys.has(policyKey(spec.name, spec.type))
      checks.push({
        name: `policy:${label}`,
        passed: present,
        message: present ? `Policy "${label}" is present.` : `Policy "${label}" is missing.`,
        latencyMs: Date.now() - started,
      })
    }
  } catch (error) {
    checks.push({
      name: 'policies:list',
      passed: false,
      message: error instanceof Error ? error.message : 'Failed to list policies',
      latencyMs: Date.now() - started,
    })
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
