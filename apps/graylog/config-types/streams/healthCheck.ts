import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, graylogRequest } from '../../lib/graylogApi'

/**
 * Health for streams config = Graylog answers on its REST API with the configured
 * credential. Read-only: GET /api/system. Any response below 500 counts as
 * reachable (auth nuances surface at deploy time, not here). Verify /api/system
 * against a live Graylog instance.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const checks: HealthCheck[] = []

  if (!credential) {
    checks.push({ name: 'credential', passed: false, message: 'No credential attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)
  const started = Date.now()
  try {
    const res = await graylogRequest(`${base}/api/system`, { headers, timeoutMs: 8000 })
    const passed = res.status > 0 && res.status < 500
    checks.push({
      name: 'graylog_reachable',
      passed,
      message: passed ? `Graylog reachable (HTTP ${res.status}).` : `Graylog returned HTTP ${res.status}.`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'graylog_reachable',
      passed: false,
      message: `Graylog unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
