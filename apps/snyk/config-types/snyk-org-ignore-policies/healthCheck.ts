import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient } from '../../lib/snyk'
import { listPolicies } from './deploy'
import { extractPolicySpecs, policyKey } from './validate'

/**
 * Health check for org-level ignore-policy configuration:
 *   1. Snyk API reachability + token/org validity (a policies list — also
 *      confirms Code Consistent Ignores is enabled, since Snyk 403s otherwise)
 *   2. Every declared policy still exists (matched by name)
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildSnykClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'snyk_credential', passed: false, message: built.error }] }
  }
  const { client, host } = built
  if (!client.hasOrg) {
    return { healthy: false, score: 0, checks: [{ name: 'snyk_org', passed: false, message: 'No Snyk organization id set' }] }
  }

  const start = Date.now()
  let live: Awaited<ReturnType<typeof listPolicies>> | null = null
  try {
    live = await listPolicies(client)
    checks.push({
      name: 'snyk_reachable',
      passed: true,
      message: `Snyk API reachable at ${host} (Code Consistent Ignores is enabled)`,
      latencyMs: Date.now() - start,
    })
  } catch (error) {
    checks.push({
      name: 'snyk_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    })
  }

  if (live) {
    const names = new Set(live.filter((p) => p.attributes?.name).map((p) => policyKey(p.attributes!.name as string)))
    for (const spec of extractPolicySpecs(ctx.canvas).filter((s) => s.name)) {
      const present = names.has(policyKey(spec.name))
      checks.push({
        name: `policy:${spec.name}`,
        passed: present,
        message: present ? `Ignore policy "${spec.name}" is present` : `Ignore policy "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
