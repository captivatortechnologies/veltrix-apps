import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson } from '../../lib/okta'
import { findGroupRuleByName } from './deploy'
import { extractGroupRuleSpecs } from './validate'

/**
 * Health check for group-rule configuration:
 *   1. Okta API reachability + token validity + admin read (GET /org — a 401/403
 *      means the SSWS token was rejected).
 *   2. Every declared rule (matched by name) still exists in the org.
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
      throw new Error('Okta rejected the API token (SSWS) — check the token and its admin permissions')
    }
    if (!res.ok) throw new Error(oktaErrorMessage(res))
    const org = parseJson<{ companyName?: string; subdomain?: string }>(res.body)
    const name = org?.companyName || org?.subdomain
    return `Okta API reachable at ${baseUrl}${name ? ` (${name})` : ''}`
  })
  checks.push(reachable)

  // Check 2..n: each declared rule still exists (re-found by its name).
  if (reachable.passed) {
    const specs = extractGroupRuleSpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`rule:${spec.name}`, async () => {
          const live = await findGroupRuleByName(client, spec.name)
          if (!live) throw new Error(`Group rule "${spec.name}" does not exist in the org`)
          return `Group rule "${spec.name}" is present (status: ${live.status ?? 'unknown'})`
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
