import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildTeleportClient, teleportErrorMessage } from '../../lib/teleport'
import { getDatabase } from './deploy'
import { extractDatabaseSpecs } from './validate'

/**
 * Health check for database configuration:
 *   1. The session logs in and can list databases on the target cluster/site
 *   2. Every declared database still exists
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildTeleportClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'teleport_credential', passed: false, message: built.error }],
    }
  }
  const { client, baseUrl } = built

  const reachable = await timedCheck('teleport_session', async () => {
    const site = await client.resolveSite()
    const res = await client.request('GET', `/v1/webapi/sites/${encodeURIComponent(site)}/databases`)
    if (!res.ok) throw new Error(teleportErrorMessage(res))
    return `Logged in and listed databases on cluster "${site}" at ${baseUrl}`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractDatabaseSpecs(ctx.canvas).filter((s) => s.name && s.protocol && s.uri)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`database:${spec.name}`, async () => {
          const live = await getDatabase(client, spec.name)
          if (!live) throw new Error(`Database "${spec.name}" does not exist in Teleport`)
          return `Database "${spec.name}" is present`
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
    return {
      name,
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    }
  }
}
