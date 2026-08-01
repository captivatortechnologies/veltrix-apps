import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildRecordedFutureClient } from '../../lib/recordedFutureApi'

/**
 * Health for the Watch Lists config = Recorded Future answers on the List API with
 * the configured token. Read-only probe: POST /list/search { limit: 1 }. A 2xx (or
 * any response below 500) counts as reachable; 401/403 mean the token is bad or
 * lacks List API access.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { credential, settings, component } = ctx
  const checks: HealthCheck[] = []

  if (!credential) {
    checks.push({ name: 'credential', passed: false, message: 'No credential attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const built = buildRecordedFutureClient(credential, settings, component?.hostname)
  if ('error' in built) {
    checks.push({ name: 'credential', passed: false, message: built.error })
    return { healthy: false, score: 0, checks }
  }
  const { client } = built

  const started = Date.now()
  try {
    const res = await client.health()
    const passed = res.status > 0 && res.status < 500
    checks.push({
      name: 'recorded_future_reachable',
      passed,
      message: passed
        ? `Recorded Future List API reachable (HTTP ${res.status}).`
        : `Recorded Future returned HTTP ${res.status}.`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'recorded_future_reachable',
      passed: false,
      message: `Recorded Future unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
