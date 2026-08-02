import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildTwingateClient } from '../../lib/twingateApi'
import { listServiceAccounts } from './deploy'
import { extractServiceAccountSpecs, serviceAccountKey, type LiveServiceAccount } from './_shared'

/**
 * Health check for Service Account configuration:
 *   1. Twingate GraphQL reachability + API key validity (an account list)
 *   2. Every declared account (by name) still exists
 * Score is the percentage of passed checks (0-100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildTwingateClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'twingate_credential', passed: false, message: built.error }] }
  }
  const { client, graphqlUrl } = built

  const specs = extractServiceAccountSpecs(ctx.canvas).filter((s) => s.name)

  const reachable = await timedCheck('twingate_reachable', async () => {
    const live = await listServiceAccounts(client)
    return { message: `Twingate reachable at ${graphqlUrl}`, live }
  })
  checks.push({ name: reachable.name, passed: reachable.passed, message: reachable.message, latencyMs: reachable.latencyMs })

  if (reachable.passed && reachable.live) {
    const names = new Set(reachable.live.filter((a) => a.name).map((a) => serviceAccountKey(a.name as string)))
    for (const spec of specs) {
      const present = names.has(serviceAccountKey(spec.name))
      checks.push({
        name: `service-account:${spec.name}`,
        passed: present,
        message: present ? `Service Account "${spec.name}" is present` : `Service Account "${spec.name}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = checks.length === 0 ? 0 : Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}

async function timedCheck(
  name: string,
  fn: () => Promise<{ message: string; live?: LiveServiceAccount[] }>,
): Promise<{ name: string; passed: boolean; message: string; latencyMs: number; live?: LiveServiceAccount[] }> {
  const start = Date.now()
  try {
    const { message, live } = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start, live }
  } catch (error) {
    return { name, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start }
  }
}
