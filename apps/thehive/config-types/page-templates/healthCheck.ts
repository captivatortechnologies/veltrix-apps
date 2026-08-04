import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildThehiveUrl, buildAuthHeader, thehiveRequest, PRIMARY } from '../../lib/thehiveApi'

/**
 * Health for page-templates config = TheHive answers on its REST API with the
 * configured API key. Read-only: GET /api/v1/user/current. A 2xx confirms the
 * endpoint resolves AND the key authenticates; any response below 500 counts as
 * reachable. This is the generic connectivity probe (same as every other type
 * in this app) — it does not assert TheHive 5 specifically; deploy/driftDetect
 * carry the v5-only gate. Verify against a live TheHive (see README, v4 vs v5).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const checks: HealthCheck[] = []

  if (!credential) {
    checks.push({ name: 'credential', passed: false, message: 'No credential attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const base = buildThehiveUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)
  const started = Date.now()
  try {
    const res = await thehiveRequest(`${base}${PRIMARY.currentUser}`, { headers, timeoutMs: 8000 })
    const passed = res.status > 0 && res.status < 500
    checks.push({
      name: 'thehive_reachable',
      passed,
      message: passed ? `TheHive reachable (HTTP ${res.status}).` : `TheHive returned HTTP ${res.status}.`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'thehive_reachable',
      passed: false,
      message: `TheHive unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
