import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSnykClient } from '../../lib/snyk'
import { listMemberships } from './deploy'
import { extractMembershipSpecs, membershipKey } from './validate'

/**
 * Health check for org-membership configuration:
 *   1. Snyk API reachability + token/org validity (a memberships list)
 *   2. Every declared membership still exists, with the declared role
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
  let live: Awaited<ReturnType<typeof listMemberships>> | null = null
  try {
    live = await listMemberships(client)
    checks.push({ name: 'snyk_reachable', passed: true, message: `Snyk API reachable at ${host}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({
      name: 'snyk_reachable',
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    })
  }

  if (live) {
    const byUser = new Map(
      live.filter((m) => m.relationships?.user?.data?.id).map((m) => [membershipKey(m.relationships!.user!.data!.id as string), m]),
    )
    for (const spec of extractMembershipSpecs(ctx.canvas).filter((s) => s.userId)) {
      const found = byUser.get(membershipKey(spec.userId))
      const roleMatches = Boolean(found && (!spec.roleId || found.relationships?.role?.data?.id === spec.roleId))
      const label = spec.email ? `${spec.userId} (${spec.email})` : spec.userId
      checks.push({
        name: `membership:${spec.userId}`,
        passed: roleMatches,
        message: !found
          ? `Membership for "${label}" is missing`
          : roleMatches
            ? `Membership for "${label}" has the expected role`
            : `Membership for "${label}" has a different role than declared`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
