import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildSysdigClient } from '../../lib/sysdigApi'

/**
 * Health for the notification-channels config = Sysdig Secure answers on its
 * REST API with the configured Bearer token. Read-only probe of the exact API
 * surface this config type writes to: GET /api/notificationChannels.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheck[] = []

  const built = buildSysdigClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) {
    checks.push({ name: 'credential', passed: false, message: built.error })
    return { healthy: false, score: 0, checks }
  }
  const { client } = built

  const started = Date.now()
  try {
    const res = await client.request('GET', '/api/notificationChannels')
    const latencyMs = Date.now() - started
    if (res.status === 401 || res.status === 403) {
      checks.push({
        name: 'sysdig_authenticated',
        passed: false,
        message: `Reached Sysdig Secure but authentication failed (HTTP ${res.status}). Check the API token.`,
        latencyMs,
      })
    } else {
      const passed = res.status > 0 && res.status < 500
      checks.push({
        name: 'sysdig_reachable',
        passed,
        message: passed ? `Sysdig Secure notification channels API reachable (HTTP ${res.status}).` : `Sysdig Secure returned HTTP ${res.status}.`,
        latencyMs,
      })
    }
  } catch (error) {
    checks.push({
      name: 'sysdig_reachable',
      passed: false,
      message: `Sysdig Secure unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
