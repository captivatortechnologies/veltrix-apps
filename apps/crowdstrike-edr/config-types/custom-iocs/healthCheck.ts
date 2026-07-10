import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconErrorMessage, parseEnvelope } from '../../lib/falcon'
import { iocIdentityFilter } from './deploy'
import { extractIocSpecs } from './validate'

/**
 * Health check for custom IOC configuration:
 *   1. Falcon API reachability + credential validity (IOC Management scope)
 *   2. Every declared indicator exists in the tenant
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

  // Check 1: API reachable and the client has the IOC Management scope
  const reachable = await timedCheck('falcon_reachable', async () => {
    const res = await client.request('GET', '/iocs/queries/indicators/v1', { query: { limit: 1 } })
    if (res.status === 401) throw new Error('Falcon API client rejected (401) — check the client secret')
    if (res.status === 403) {
      throw new Error('Falcon API client lacks the "IOC Management: Read" scope (403)')
    }
    if (!res.ok) throw new Error(falconErrorMessage(res))
    return `Falcon API reachable at ${baseUrl}`
  })
  checks.push(reachable)

  // Check 2..n: each declared indicator exists
  if (reachable.passed) {
    const specs = extractIocSpecs(ctx.canvas).filter((s) => s.type && s.value)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`ioc:${spec.value}`, async () => {
          const res = await client.request('GET', '/iocs/queries/indicators/v1', {
            query: { filter: iocIdentityFilter(spec.type, spec.value), limit: 1 },
          })
          if (!res.ok) throw new Error(falconErrorMessage(res))
          const found = parseEnvelope<string>(res.body)?.resources?.length ?? 0
          if (found === 0) {
            throw new Error(`Indicator "${spec.value}" (${spec.type}) does not exist in the tenant`)
          }
          return `Indicator "${spec.value}" is present`
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
