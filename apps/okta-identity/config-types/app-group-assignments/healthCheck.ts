import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { getAssignment } from './deploy'
import { extractAppGroupAssignmentSpecs } from './validate'

/**
 * Health check for app-group assignment configuration:
 *   1. Okta API reachability + SSWS token validity (GET /org — proves the token
 *      is accepted and has admin read; 401/403 means the token was rejected)
 *   2. Every declared (appId, groupId) assignment still exists (GET the
 *      assignment; a 404 means the group is no longer assigned to the app)
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'okta_credential', passed: false, message: built.error }],
    }
  }
  const { client, baseUrl } = built

  // Check 1: API reachable and the SSWS token is accepted with admin read.
  const reachable = await timedCheck('okta_reachable', async () => {
    const res = await client.request('GET', '/org')
    if (res.status === 401 || res.status === 403) {
      throw new Error('Okta rejected the API token (SSWS) — check it is valid and belongs to an admin with read access')
    }
    if (!res.ok) throw new Error(oktaErrorMessage(res))
    return `Okta API reachable at ${baseUrl}`
  })
  checks.push(reachable)

  // Check 2..n: each declared assignment still exists.
  if (reachable.passed) {
    const specs = extractAppGroupAssignmentSpecs(ctx.canvas).filter((s) => s.appId && s.groupId)
    for (const spec of specs) {
      const label = `${spec.appId}:${spec.groupId}`
      checks.push(
        await timedCheck(`assignment:${label}`, async () => {
          const live = await getAssignment(client, spec.appId, spec.groupId)
          if (!live) {
            throw new Error(`Group "${spec.groupId}" is not assigned to app "${spec.appId}"`)
          }
          return `Assignment "${label}" is present`
        }),
      )
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)

  return {
    healthy: passedCount === checks.length,
    score,
    checks,
  }
}

async function timedCheck(
  name: string,
  fn: () => Promise<string>,
): Promise<HealthCheckResult['checks'][0]> {
  const start = Date.now()
  try {
    const message = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start }
  } catch (error) {
    return {
      name,
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    }
  }
}
