import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildVectraApiBase, buildAuthHeader, vectraRequest } from '../../lib/vectraApi'

/**
 * Health for triage rules = Vectra answers on its Detect REST API with the
 * configured API token. Read-only: GET /rules?page_size=1. Any response below 500
 * counts as reachable (auth nuances surface at deploy time, not here). Verify
 * against a live Vectra brain.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const checks: HealthCheck[] = []

  if (!credential) {
    checks.push({ name: 'credential', passed: false, message: 'No credential attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const base = buildVectraApiBase(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)
  const started = Date.now()
  try {
    const res = await vectraRequest(`${base}/rules?page_size=1`, { headers, timeoutMs: 8000 })
    const passed = res.status > 0 && res.status < 500
    checks.push({
      name: 'vectra_reachable',
      passed,
      message: passed ? `Vectra reachable (HTTP ${res.status}).` : `Vectra returned HTTP ${res.status}.`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'vectra_reachable',
      passed: false,
      message: `Vectra unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
