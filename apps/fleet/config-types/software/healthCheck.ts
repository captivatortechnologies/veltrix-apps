import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader, fleetRequest, FLEET_API_BASE } from '../../lib/fleetApi'

/**
 * Health for the software config type = the Fleet server answers on its REST
 * API with the configured credential. Read-only: GET /api/v1/fleet/version. Any
 * response below 500 counts as reachable (auth/permission nuances, including
 * whether Fleet Premium software features are licensed, surface at deploy
 * time, not here). Verify against a live Fleet (fleetdm) instance.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const checks: HealthCheck[] = []

  if (!credential) {
    checks.push({ name: 'credential', passed: false, message: 'No credential attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const base = buildFleetUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)
  const started = Date.now()
  try {
    const res = await fleetRequest(`${base}${FLEET_API_BASE}/version`, { headers, timeoutMs: 8000 })
    const passed = res.status > 0 && res.status < 500
    checks.push({
      name: 'fleet_reachable',
      passed,
      message: passed
        ? `Fleet server reachable (HTTP ${res.status}).`
        : `Fleet server returned HTTP ${res.status}.`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'fleet_reachable',
      passed: false,
      message: `Fleet server unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
