import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildSocUrl, buildAuthHeader, soRequest } from '../../lib/soConsole'

/**
 * Health for detections config = the Kibana Detection Engine answers on the SOC
 * console with the configured credential. Read-only: GET
 * /api/detection_engine/rules/_find. Any response below 500 counts as reachable
 * (auth/permission nuances surface at deploy time, not here).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const checks: HealthCheck[] = []

  if (!credential) {
    checks.push({ name: 'credential', passed: false, message: 'No credential attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const base = buildSocUrl(component, connectivity, connectivityProvider)
  const headers = { ...buildAuthHeader(credential), 'kbn-xsrf': 'true' }
  const started = Date.now()
  try {
    const res = await soRequest(`${base}/api/detection_engine/rules/_find?per_page=1`, { headers, timeoutMs: 8000 })
    const passed = res.status > 0 && res.status < 500
    checks.push({
      name: 'detection_engine_reachable',
      passed,
      message: passed
        ? `Kibana Detection Engine reachable (HTTP ${res.status}).`
        : `Kibana Detection Engine returned HTTP ${res.status}.`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'detection_engine_reachable',
      passed: false,
      message: `Kibana Detection Engine unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
