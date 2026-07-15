import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient, parseJson, tenableErrorMessage } from '../../lib/tenable'
import { findTagValue } from './deploy'
import { extractTagSpecs } from './validate'

/**
 * Health check for tag configuration:
 *   1. Tenable API reachability + credential validity (GET /server/status)
 *   2. Every declared tag (category:value) still exists in the tenant
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildTenableClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'tenable_credential', passed: false, message: built.error }],
    }
  }
  const { client, baseUrl } = built

  // Check 1: API reachable and the key pair is accepted
  const reachable = await timedCheck('tenable_reachable', async () => {
    const res = await client.request('GET', '/server/status')
    if (res.status === 401 || res.status === 403) {
      throw new Error('Tenable rejected the API key pair (check the access/secret keys)')
    }
    if (!res.ok) throw new Error(tenableErrorMessage(res))
    const status = parseJson<{ status?: string }>(res.body)?.status
    if (status && status !== 'ready') {
      throw new Error(`Tenable server status is "${status}", expected "ready"`)
    }
    return `Tenable API reachable at ${baseUrl}${status ? ` (status: ${status})` : ''}`
  })
  checks.push(reachable)

  // Check 2..n: each declared tag value still exists (re-found by its pair)
  if (reachable.passed) {
    const specs = extractTagSpecs(ctx.canvas).filter((s) => s.category && s.value)
    for (const spec of specs) {
      const label = `${spec.category}:${spec.value}`
      checks.push(
        await timedCheck(`tag:${label}`, async () => {
          const live = await findTagValue(client, spec.category, spec.value)
          if (!live) throw new Error(`Tag "${label}" does not exist in the tenant`)
          return `Tag "${label}" is present`
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
