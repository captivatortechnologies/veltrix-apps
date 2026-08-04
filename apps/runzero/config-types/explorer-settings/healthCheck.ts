import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildRunzeroUrl, buildAuthHeader, resolveRunzeroToken, runzeroRequest } from '../../lib/runzeroApi'

/**
 * Health for the explorer-settings config = runZero answers on the org explorers endpoint with the
 * configured Organization API key. Read-only: GET /org/explorers. A 2xx confirms the key
 * authenticates and the org is reachable; a 401/403 flags the key.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const checks: HealthCheck[] = []

  if (!resolveRunzeroToken(credential)) {
    checks.push({ name: 'credential', passed: false, message: 'No runZero API key attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const base = buildRunzeroUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)
  const rawTimeout = settings?.request_timeout_seconds
  const timeoutMs = typeof rawTimeout === 'number' && rawTimeout > 0 ? rawTimeout * 1000 : 8000

  const started = Date.now()
  try {
    const res = await runzeroRequest(`${base}/org/explorers`, { headers, timeoutMs })
    const authOk = res.status !== 401 && res.status !== 403
    const passed = res.ok
    checks.push({
      name: 'runzero_explorers_reachable',
      passed,
      message: passed
        ? `runZero explorers reachable and authenticated (HTTP ${res.status}).`
        : authOk
          ? `runZero returned HTTP ${res.status}.`
          : `runZero rejected the API key (HTTP ${res.status}).`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'runzero_explorers_reachable',
      passed: false,
      message: `runZero unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
