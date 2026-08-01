import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildTaniumBaseUrl, resolveTaniumSession, taniumRequest, sessionHeader } from '../../lib/taniumApi'

/**
 * Health for computer-groups config = Tanium authenticates the connection
 * credential AND answers on its REST v2 API. Read-only: resolve a session (API
 * token verbatim, or username/password via /api/v2/session/login) then GET
 * /api/v2/system_status. Any response below 500 counts as reachable. Verify
 * /api/v2/system_status against a live Tanium.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const checks: HealthCheck[] = []

  if (!credential) {
    checks.push({ name: 'credential', passed: false, message: 'No credential attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const base = buildTaniumBaseUrl(component, connectivity, connectivityProvider)
  const started = Date.now()
  try {
    const session = await resolveTaniumSession(base, credential, 8000)
    const res = await taniumRequest(`${base}/system_status`, { headers: sessionHeader(session), timeoutMs: 8000 })
    const passed = res.status > 0 && res.status < 500
    checks.push({
      name: 'tanium_reachable',
      passed,
      message: passed ? `Tanium reachable and authenticated (HTTP ${res.status}).` : `Tanium returned HTTP ${res.status}.`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'tanium_reachable',
      passed: false,
      message: `Tanium unreachable or authentication failed: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
