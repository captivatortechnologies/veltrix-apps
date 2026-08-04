import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage } from '../../lib/elastic'
import { listPolicies } from './deploy'
import { extractPolicySpecs } from './validate'

/**
 * Health check for Fleet package-policy configuration:
 *   1. Kibana Fleet API reachability + credential validity (GET /api/fleet/package_policies).
 *   2. Every declared policy (by name) still exists.
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'elastic_credential', passed: false, message: built.error }] }
  }
  const { client, kibanaUrl } = built

  let live: Awaited<ReturnType<typeof listPolicies>> = []
  const reachable = await timedCheck('kibana_reachable', async () => {
    const res = await client.kibana('GET', '/api/fleet/package_policies', { query: { perPage: 1 } })
    if (res.status === 401 || res.status === 403) {
      throw new Error('Kibana rejected the credential (check the API key and its Fleet privileges)')
    }
    if (!res.ok) throw new Error(elasticErrorMessage(res))
    return `Kibana Fleet API reachable at ${kibanaUrl}`
  })
  checks.push(reachable)

  if (reachable.passed) {
    try {
      live = await listPolicies(client)
    } catch {
      // Already reported as unreachable above if this fails identically; keep live empty.
    }
    const liveNames = new Set(live.filter((p) => p.name).map((p) => p.name as string))
    const specs = extractPolicySpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      checks.push(
        timedResult(`policy:${spec.name}`, liveNames.has(spec.name), `Fleet package policy "${spec.name}" is present`, `Fleet package policy "${spec.name}" does not exist`),
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
    return {
      name,
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    }
  }
}

function timedResult(name: string, passed: boolean, okMessage: string, failMessage: string): HealthCheckResult['checks'][0] {
  return { name, passed, message: passed ? okMessage : failMessage, latencyMs: 0 }
}
