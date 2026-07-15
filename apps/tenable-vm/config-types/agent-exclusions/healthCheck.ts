import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildTenableClient, parseJson, tenableErrorMessage } from '../../lib/tenable'
import { findAgentExclusion } from './deploy'
import { extractAgentExclusionSpecs } from './validate'

/** Tenable /server/status values that mean the service is serving requests. */
const READY_STATUSES = ['ready', 'nominal']

/**
 * Health check for agent exclusion configuration:
 *   1. Tenable API reachability + credential validity (GET /server/status)
 *   2. Every declared agent exclusion still exists in its cloud scanner
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

  // Check 1: API reachable, credentials accepted, and the service is ready
  const reachable = await timedCheck('tenable_reachable', async () => {
    const res = await client.request('GET', '/server/status')
    if (res.status === 401 || res.status === 403) {
      throw new Error('Tenable API rejected the credentials (check the access/secret key pair)')
    }
    if (!res.ok) throw new Error(tenableErrorMessage(res))
    const status = parseJson<{ status?: string }>(res.body)?.status
    if (status && !READY_STATUSES.includes(status.toLowerCase())) {
      throw new Error(`Tenable service is not ready (status: ${status})`)
    }
    return `Tenable API reachable at ${baseUrl}${status ? ` (status: ${status})` : ''}`
  })
  checks.push(reachable)

  // Check 2..n: each declared agent exclusion still exists in its cloud scanner
  if (reachable.passed) {
    const specs = extractAgentExclusionSpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`agent-exclusion:${spec.name}`, async () => {
          const live = await findAgentExclusion(client, spec.scannerId, spec.name)
          if (!live) throw new Error(`Agent exclusion "${spec.name}" does not exist on scanner ${spec.scannerId}`)
          return `Agent exclusion "${spec.name}" is present (id ${live.id})`
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
