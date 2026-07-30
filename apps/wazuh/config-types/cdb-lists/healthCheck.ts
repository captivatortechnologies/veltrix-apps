import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { getToken, bearerHeader, wazuhRequest } from '../../lib/wazuhApi'

/**
 * Health for CDB-lists config = the Wazuh manager API is reachable and the
 * configured credential authenticates. Authenticating (getToken) already proves
 * the credential; the follow-up GET /manager/status confirms the manager daemons
 * answer. Any response below 500 counts as reachable.
 *
 * NOTE (verify against a live Wazuh 4.x manager): /manager/status returns the
 * per-daemon run state; here we only gate on reachability, not daemon health.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const checks: HealthCheck[] = []

  if (!credential) {
    checks.push({ name: 'credential', passed: false, message: 'No credential attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const started = Date.now()
  try {
    const { baseUrl, token } = await getToken(component, connectivity, connectivityProvider, credential)
    const res = await wazuhRequest(`${baseUrl}/manager/status`, { headers: bearerHeader(token), timeoutMs: 8000 })
    const passed = res.status > 0 && res.status < 500
    checks.push({
      name: 'wazuh_manager_reachable',
      passed,
      message: passed
        ? `Wazuh manager API reachable and authenticated (HTTP ${res.status}).`
        : `Wazuh manager API returned HTTP ${res.status}.`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'wazuh_manager_reachable',
      passed: false,
      message: `Wazuh manager API unreachable or authentication failed: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
