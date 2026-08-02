import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildCriblUrl, criblConnect, criblRequest, apiRoot } from '../../lib/criblApi'

/**
 * Health for the pipelines config = Cribl authenticates the connection credential
 * and answers on its REST API. Obtains a Bearer (on-prem login or Cloud token),
 * then GET /api/v1/system/info. A response below 500 counts as reachable. Verify
 * /api/v1/system/info against a live Cribl.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const checks: HealthCheck[] = []

  if (!credential) {
    checks.push({ name: 'credential', passed: false, message: 'No credential attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const base = buildCriblUrl(component, connectivity, connectivityProvider, Number(settings?.cribl_api_port) || undefined)
  const started = Date.now()
  try {
    const headers = await criblConnect(base, credential, 8000)
    const res = await criblRequest(`${apiRoot(base)}/system/info`, { headers, timeoutMs: 8000 })
    const passed = res.status > 0 && res.status < 500
    checks.push({
      name: 'cribl_reachable',
      passed,
      message: passed ? `Cribl reachable (HTTP ${res.status}).` : `Cribl returned HTTP ${res.status}.`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'cribl_reachable',
      passed: false,
      message: `Cribl unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
