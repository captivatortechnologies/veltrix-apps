import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import {
  REST_TOKEN_MISSING,
  buildAuthHeader,
  buildRestUrl,
  getEntityContent,
  readRestSettings,
  resolveRestToken,
  resolveStackHost,
  splunkRestRequest,
} from '../../lib/splunkRest'
import { extractUserSpecs } from './validate'

/**
 * Health check for Splunk Cloud user configuration:
 *   1. the stack's REST API on port 8089 is reachable and the token is accepted
 *      (this is the check that tells the user whether Support has opened 8089
 *      and whether their IP is on the `search-api` allow list — the failure
 *      message names both, via lib/splunkRest.ts)
 *   2. every declared user exists on the stack (this app manages existing users;
 *      a missing user cannot be managed because creation needs a password)
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const token = resolveRestToken(ctx.credential)
  if (!token) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'splunk_rest_token', passed: false, message: REST_TOKEN_MISSING }],
    }
  }

  const { timeoutMs } = readRestSettings(ctx.settings)
  const stack = resolveStackHost(ctx.component.hostname)
  const baseUrl = buildRestUrl(ctx.component)
  const auth = buildAuthHeader(token)

  // Check 1: REST API reachable and token accepted
  const reachable = await timedCheck('splunk_rest_reachable', async () => {
    await splunkRestRequest(`${baseUrl}/services/authentication/users?count=1&output_mode=json`, {
      method: 'GET',
      headers: auth,
      timeoutMs,
    })
    return `Splunk Cloud REST API reachable for stack "${stack}" on port 8089`
  })
  checks.push(reachable)

  // Check 2..n: each declared user exists
  if (reachable.passed) {
    const specs = extractUserSpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`user:${spec.name}`, async () => {
          const content = await getEntityContent(
            baseUrl,
            auth,
            `/services/authentication/users/${encodeURIComponent(spec.name)}`,
            timeoutMs,
          )
          if (!content) {
            throw new Error(
              `User "${spec.name}" does not exist on the stack — create it in Splunk Web first (this app cannot create users, as that requires a password)`,
            )
          }
          return `User "${spec.name}" is present`
        }),
      )
    }
  }

  const passedCount = checks.filter((c) => c.passed).length

  return {
    healthy: passedCount === checks.length,
    score: Math.round((passedCount / checks.length) * 100),
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
