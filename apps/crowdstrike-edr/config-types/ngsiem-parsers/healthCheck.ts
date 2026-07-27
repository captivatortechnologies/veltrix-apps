import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconErrorMessage } from '../../lib/falcon'
import { findParserByName } from './deploy'
import { extractParserSpecs, PARSER_REPOSITORY } from './validate'

/**
 * Health check for Next-Gen SIEM parser configuration:
 *   1. Falcon API reachability + credential validity (NGSIEM parser scope)
 *   2. Every declared parser exists in the tenant
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

  // Check 1: API reachable and the client has the NGSIEM parser read scope
  const reachable = await timedCheck('falcon_reachable', async () => {
    const res = await client.request('GET', '/ngsiem-content/queries/parsers/v1', {
      query: { limit: 1, repository: PARSER_REPOSITORY },
    })
    if (res.status === 401) throw new Error('Falcon API client rejected (401) — check the client secret')
    if (res.status === 403) {
      throw new Error('Falcon API client lacks the Next-Gen SIEM parser read scope (403)')
    }
    if (!res.ok) throw new Error(falconErrorMessage(res))
    return `Falcon Next-Gen SIEM API reachable at ${baseUrl}`
  })
  checks.push(reachable)

  // Check 2..n: each declared parser exists
  if (reachable.passed) {
    const specs = extractParserSpecs(ctx.canvas).filter((s) => s.name && s.script.trim())
    for (const spec of specs) {
      checks.push(
        await timedCheck(`parser:${spec.name}`, async () => {
          const live = await findParserByName(client, spec.name, spec.repository)
          if (!live) {
            throw new Error(`Parser "${spec.name}" does not exist in the tenant`)
          }
          return `Parser "${spec.name}" is present`
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
