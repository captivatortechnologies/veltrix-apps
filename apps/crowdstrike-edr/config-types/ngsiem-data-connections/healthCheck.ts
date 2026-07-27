import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconErrorMessage } from '../../lib/falcon'
import { CONNECTION_COLLECTION, findByName, listDataConnections } from './deploy'
import { extractConnectionSpecs } from './validate'

/**
 * Health check for data connection configuration:
 *   1. Falcon Next-Gen SIEM API reachability + credential validity
 *   2. Every declared connection exists on the tenant (matched by name)
 * Score is the percentage of passed checks (0–100). Secrets are never read.
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

  // Check 1: API reachable and the client has the Next-Gen SIEM scope
  const reachable = await timedCheck('falcon_reachable', async () => {
    const res = await client.request('GET', CONNECTION_COLLECTION, { query: { limit: 1 } })
    if (res.status === 401) throw new Error('Falcon API client rejected (401) — check the client secret')
    if (res.status === 403) {
      throw new Error('Falcon API client lacks the Next-Gen SIEM data connections scope (403)')
    }
    if (!res.ok) throw new Error(falconErrorMessage(res))
    return `Falcon Next-Gen SIEM API reachable at ${baseUrl}`
  })
  checks.push(reachable)

  // Check 2..n: each declared connection exists
  if (reachable.passed) {
    const specs = extractConnectionSpecs(ctx.canvas).filter(
      (s) => s.name && s.connectorType && s.targetRepository,
    )
    if (specs.length > 0) {
      let live: Awaited<ReturnType<typeof listDataConnections>> = []
      const listed = await timedCheck('connections_listed', async () => {
        live = await listDataConnections(client)
        return `Loaded ${live.length} data connection(s)`
      })
      checks.push(listed)

      if (listed.passed) {
        for (const spec of specs) {
          checks.push(
            await timedCheck(`connection:${spec.name}`, async () => {
              const found = findByName(live, spec.name)
              if (!found) {
                throw new Error(`Connection "${spec.name}" does not exist in the tenant`)
              }
              return `Connection "${spec.name}" is present`
            }),
          )
        }
      }
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
