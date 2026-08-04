import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildFleetUrl, buildAuthHeader, fleetRequest, getJson, FLEET_API_BASE } from '../../lib/fleetApi'

/**
 * Health for the configuration-profiles config type: the Fleet server answers
 * on its REST API with the configured credential, AND MDM is turned on for
 * at least one platform — deploying profiles against an MDM-off server queues
 * silently instead of applying. Verify against a live Fleet (fleetdm) instance.
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
      message: passed ? `Fleet server reachable (HTTP ${res.status}).` : `Fleet server returned HTTP ${res.status}.`,
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

  try {
    const config = await getJson<{ mdm?: { enabled_and_configured?: boolean; windows_enabled_and_configured?: boolean } }>(
      `${base}${FLEET_API_BASE}/config`,
      headers,
    )
    const mdmOn = Boolean(config.mdm?.enabled_and_configured || config.mdm?.windows_enabled_and_configured)
    checks.push({
      name: 'mdm_enabled',
      passed: mdmOn,
      message: mdmOn ? 'MDM is turned on for at least one platform.' : 'MDM is not turned on — configuration profiles will not be delivered to hosts.',
    })
  } catch {
    // best-effort — org config read failure doesn't fail health on its own
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
