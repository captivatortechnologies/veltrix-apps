import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, mispRequest } from '../../lib/mispApi'

/**
 * Health for organisations config = MISP answers on its REST API with the
 * configured automation key. Read-only: GET /servers/getVersion. Any response
 * below 500 counts as reachable (auth nuances surface at deploy time, not here).
 * Verify /servers/getVersion against a live MISP 2.4 instance.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const checks: HealthCheck[] = []

  if (!credential) {
    checks.push({ name: 'credential', passed: false, message: 'No credential attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)
  const started = Date.now()
  try {
    const res = await mispRequest(`${base}/servers/getVersion`, { headers, timeoutMs: 8000 })
    const passed = res.status > 0 && res.status < 500
    checks.push({
      name: 'misp_reachable',
      passed,
      message: passed ? `MISP reachable (HTTP ${res.status}).` : `MISP returned HTTP ${res.status}.`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'misp_reachable',
      passed: false,
      message: `MISP unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
