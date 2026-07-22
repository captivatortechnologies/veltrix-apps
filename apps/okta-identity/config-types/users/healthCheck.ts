import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { getUserByLogin } from './deploy'
import { extractUserSpecs } from './validate'

/**
 * Health check for user configuration:
 *   1. Okta API reachability + token validity (GET /org).
 *   2. Every declared user still resolves in the org (by login).
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'okta_credential', passed: false, message: built.error }] }
  }
  const { client, baseUrl } = built

  const reachable = await timedCheck('okta_reachable', async () => {
    const res = await client.request('GET', '/org')
    if (res.status === 401 || res.status === 403) {
      throw new Error('Okta rejected the API token (SSWS token invalid or lacks admin read)')
    }
    if (!res.ok) throw new Error(oktaErrorMessage(res))
    return `Okta API reachable at ${baseUrl}`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractUserSpecs(ctx.canvas).filter((s) => s.login)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`user:${spec.login}`, async () => {
          const live = await getUserByLogin(client, spec.login)
          if (!live) throw new Error(`User "${spec.login}" does not exist in the org`)
          return `User "${spec.login}" is present (${live.status ?? 'unknown status'})`
        }),
      )
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

async function timedCheck(name: string, fn: () => Promise<string>): Promise<HealthCheckResult['checks'][0]> {
  const start = Date.now()
  try {
    const message = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start }
  } catch (error) {
    return { name, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start }
  }
}
