import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildSemgrepClient } from '../../lib/semgrepApi'

/**
 * Health for project settings = Semgrep answers on its public API with the
 * configured token. Read-only: GET /api/v1/deployments. A 2xx means the token is
 * valid and reachable; 401/403 mean the token is bad.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { credential, settings } = ctx
  const checks: HealthCheck[] = []

  if (!credential) {
    checks.push({ name: 'credential', passed: false, message: 'No credential attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const built = buildSemgrepClient(credential, settings)
  if ('error' in built) {
    checks.push({ name: 'credential', passed: false, message: built.error })
    return { healthy: false, score: 0, checks }
  }
  const { client } = built

  const started = Date.now()
  try {
    const res = await client.listDeployments()
    const passed = res.status >= 200 && res.status < 300
    checks.push({
      name: 'semgrep_reachable',
      passed,
      message: passed
        ? 'Semgrep API reachable and token accepted (GET /api/v1/deployments).'
        : res.status === 401 || res.status === 403
          ? `Semgrep rejected the API token (HTTP ${res.status}).`
          : `Semgrep API returned HTTP ${res.status}.`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'semgrep_reachable',
      passed: false,
      message: `Semgrep API unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
