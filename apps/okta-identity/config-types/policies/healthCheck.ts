import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage, parseJson } from '../../lib/okta'
import { findPolicy } from './deploy'
import { extractPolicySpecs } from './validate'

/**
 * Health check for policy configuration:
 *   1. Okta API reachability + admin read (GET /org) — proves the SSWS token is
 *      valid; a 401/403 means the token was rejected.
 *   2. Every declared policy (matched by (type, name)) still exists in the org.
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
      throw new Error('Okta rejected the API token (check the SSWS token and its admin permissions)')
    }
    if (!res.ok) throw new Error(oktaErrorMessage(res))
    const org = parseJson<{ companyName?: string; subdomain?: string }>(res.body)
    const who = org?.companyName || org?.subdomain
    return `Okta API reachable at ${baseUrl}${who ? ` (org: ${who})` : ''}`
  })
  checks.push(reachable)

  // Check 2..n: each declared policy still exists (re-found by (type, name)).
  if (reachable.passed) {
    const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.type && s.name)
    for (const spec of specs) {
      const label = `${spec.type}:${spec.name}`
      checks.push(
        await timedCheck(`policy:${label}`, async () => {
          const live = await findPolicy(client, spec.type, spec.name)
          if (!live) throw new Error(`Policy "${label}" does not exist in the org`)
          return `Policy "${label}" is present`
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
