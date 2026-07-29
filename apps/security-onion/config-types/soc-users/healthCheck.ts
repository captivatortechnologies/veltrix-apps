import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildSocUrl, buildAuthHeader, soRequest } from '../../lib/soConsole'

/**
 * Health for soc-users config = the SOC console is reachable with the configured
 * credential (a user-state deploy needs the manager up). Read-only.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const checks: HealthCheck[] = []

  if (!credential) {
    checks.push({ name: 'credential', passed: false, message: 'No credential attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const base = buildSocUrl(component, connectivity, connectivityProvider)
  const started = Date.now()
  try {
    const res = await soRequest(`${base}/login`, { headers: buildAuthHeader(credential), timeoutMs: 8000 })
    const passed = res.status > 0 && res.status < 500
    checks.push({
      name: 'soc_reachable',
      passed,
      message: passed ? `SOC console reachable (HTTP ${res.status}).` : `SOC console returned HTTP ${res.status}.`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'soc_reachable',
      passed: false,
      message: `SOC console unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
