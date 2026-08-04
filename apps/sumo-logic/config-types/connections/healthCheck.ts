import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, sumoRequest } from '../../lib/sumoLogicApi'

/**
 * Health for the connections config = Sumo Logic answers on the Management API
 * with the configured Access ID / Access Key. Read-only: GET /connections. Any
 * response below 500 counts as reachable.
 *
 * API: https://www.sumologic.com/help/docs/api/connection-management/
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity } = ctx
  const checks: HealthCheck[] = []

  if (!hasBasicAuth(credential)) {
    checks.push({ name: 'credential', passed: false, message: 'No Access ID / Access Key attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)
  const started = Date.now()
  try {
    const res = await sumoRequest(`${base}/connections?limit=1`, { headers, timeoutMs: 8000 })
    const passed = res.status > 0 && res.status < 500
    checks.push({
      name: 'sumo_reachable',
      passed,
      message: passed ? `Sumo Logic reachable (HTTP ${res.status}).` : `Sumo Logic returned HTTP ${res.status}.`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'sumo_reachable',
      passed: false,
      message: `Sumo Logic unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
