import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildRunzeroUrl, buildAuthHeader, resolveRunzeroToken, runzeroRequest } from '../../lib/runzeroApi'

/**
 * Health for the sso-group-mappings config = runZero answers on the ACCOUNT SSO groups endpoint
 * with the configured API key. Read-only: GET /account/sso/groups. A 2xx confirms the key
 * authenticates AND is account-scoped; a 401/403 flags the key — most often an Organization key
 * used where an account-scoped key is required (see the config type's _shared header).
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
    const res = await runzeroRequest(`${base}/account/sso/groups`, { headers, timeoutMs })
    const authOk = res.status !== 401 && res.status !== 403
    const passed = res.ok
    checks.push({
      name: 'runzero_sso_groups_reachable',
      passed,
      message: passed
        ? `runZero account SSO group mappings reachable and authenticated (HTTP ${res.status}).`
        : authOk
          ? `runZero returned HTTP ${res.status}.`
          : `runZero rejected the API key (HTTP ${res.status}) — this endpoint needs an account-scoped key.`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'runzero_sso_groups_reachable',
      passed: false,
      message: `runZero unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
