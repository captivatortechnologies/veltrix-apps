import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconErrorMessage } from '../../lib/falcon'
import { INSTALLATION_TOKEN_ENDPOINTS, findTokenByLabel } from './deploy'
import { extractInstallationTokenSpecs } from './validate'

/**
 * Health check for installation token configuration:
 *   1. Falcon API reachability + credential validity (Installation Tokens scope)
 *   2. Every declared token exists in the tenant
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'falcon_credential', passed: false, message: built.error }],
    }
  }
  const { client, baseUrl } = built

  // Check 1: API reachable and the client has the Installation Tokens scope
  const reachable = await timedCheck('falcon_reachable', async () => {
    const res = await client.request('GET', INSTALLATION_TOKEN_ENDPOINTS.queries, {
      query: { limit: 1 },
    })
    if (res.status === 401) throw new Error('Falcon API client rejected (401) — check the client secret')
    if (res.status === 403) {
      throw new Error('Falcon API client lacks the "Installation tokens (sensor): Read" scope (403)')
    }
    if (!res.ok) throw new Error(falconErrorMessage(res))
    return `Falcon API reachable at ${baseUrl}`
  })
  checks.push(reachable)

  // Check 2..n: each declared token exists
  if (reachable.passed) {
    const specs = extractInstallationTokenSpecs(ctx.canvas).filter((s) => s.label)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`token:${spec.label}`, async () => {
          const live = await findTokenByLabel(client, spec.label)
          if (!live) {
            throw new Error(`Installation token "${spec.label}" does not exist in the tenant`)
          }
          return `Installation token "${spec.label}" is present`
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
