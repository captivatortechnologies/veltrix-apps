import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildUmbrellaClient, umbrellaErrorMessage } from '../../lib/umbrellaApi'
import { LIST_PATH } from './_shared'

/**
 * Health for destination lists = Umbrella authenticates the API key/secret and
 * answers the destination lists collection. Read-only: GET
 * /policies/v2/destinationlists?limit=1.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []
  const built = buildUmbrellaClient(ctx.credential, ctx.settings)
  if ('error' in built) {
    checks.push({ name: 'credential', passed: false, message: built.error })
    return { healthy: false, score: 0, checks }
  }

  const start = Date.now()
  try {
    const res = await built.client.get(LIST_PATH, { page: 1, limit: 1 })
    const latencyMs = Date.now() - start
    checks.push({
      name: 'umbrella-destination-lists',
      passed: res.ok,
      message: res.ok ? 'Reached the Umbrella destination lists API.' : `Umbrella error: ${umbrellaErrorMessage(res)}`,
      latencyMs,
    })
  } catch (err) {
    checks.push({
      name: 'umbrella-destination-lists',
      passed: false,
      message: `Umbrella unreachable: ${err instanceof Error ? err.message : 'error'}`,
      latencyMs: Date.now() - start,
    })
  }

  const passed = checks.every((c) => c.passed)
  return { healthy: passed, score: passed ? 100 : 0, checks }
}
