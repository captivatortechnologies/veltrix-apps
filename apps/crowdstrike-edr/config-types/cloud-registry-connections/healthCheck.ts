import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconErrorMessage } from '../../lib/falcon'
import { findByAlias, listRegistries, REGISTRY_QUERIES } from './deploy'
import { extractRegistrySpecs } from './validate'

/**
 * Health check for registry connection configuration:
 *   1. Falcon Cloud Security API reachability + credential validity
 *   2. Every declared registry exists on the tenant (matched by alias)
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

  // Check 1: API reachable and the client has the registries scope
  const reachable = await timedCheck('falcon_reachable', async () => {
    const res = await client.request('GET', REGISTRY_QUERIES, { query: { limit: 1 } })
    if (res.status === 401) throw new Error('Falcon API client rejected (401) — check the client secret')
    if (res.status === 403) {
      throw new Error('Falcon API client lacks the Falcon Container Image / registries scope (403)')
    }
    if (!res.ok) throw new Error(falconErrorMessage(res))
    return `Falcon Cloud Security API reachable at ${baseUrl}`
  })
  checks.push(reachable)

  // Check 2..n: each declared registry exists
  if (reachable.passed) {
    const specs = extractRegistrySpecs(ctx.canvas).filter((s) => s.name && s.url && s.type)
    if (specs.length > 0) {
      let live: Awaited<ReturnType<typeof listRegistries>> = []
      const listed = await timedCheck('registries_listed', async () => {
        live = await listRegistries(client)
        return `Loaded ${live.length} registry connection(s)`
      })
      checks.push(listed)

      if (listed.passed) {
        for (const spec of specs) {
          checks.push(
            await timedCheck(`registry:${spec.name}`, async () => {
              const found = findByAlias(live, spec.name)
              if (!found) {
                throw new Error(`Registry "${spec.name}" does not exist in the tenant`)
              }
              return `Registry "${spec.name}" is present`
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
