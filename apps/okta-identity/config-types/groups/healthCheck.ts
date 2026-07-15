import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { findGroupByName, listOktaGroups } from './deploy'
import { extractGroupSpecs, type LiveGroup } from './validate'

/**
 * Health check for group configuration:
 *   1. Okta API reachability + token validity (GET /org — proves the SSWS token
 *      is accepted and has admin read; 401/403 => token rejected)
 *   2. Every declared group still exists as an OKTA_GROUP in the org
 * Score is the percentage of passed checks (0-100).
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
  let oktaGroups: LiveGroup[] = []
  const reachable = await timedCheck('okta_reachable', async () => {
    const res = await client.request('GET', '/org')
    if (res.status === 401 || res.status === 403) {
      throw new Error('Okta rejected the API token (SSWS token invalid or lacks admin read)')
    }
    if (!res.ok) throw new Error(oktaErrorMessage(res))
    // Prime the OKTA_GROUP list for the per-group checks below.
    oktaGroups = await listOktaGroups(client)
    return `Okta API reachable at ${baseUrl}`
  })
  checks.push(reachable)

  // Check 2..n: each declared group still exists as an OKTA_GROUP.
  if (reachable.passed) {
    const specs = extractGroupSpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`group:${spec.name}`, async () => {
          const live = findGroupByName(oktaGroups, spec.name)
          if (!live) throw new Error(`Group "${spec.name}" does not exist as an OKTA_GROUP in the org`)
          return `Group "${spec.name}" is present`
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
