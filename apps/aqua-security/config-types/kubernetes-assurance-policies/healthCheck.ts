import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildAquaClient } from '../../lib/aquasec'

/**
 * Health for the kubernetes-assurance-policies config = the Aqua Console answers
 * on its assurance-policy REST API with the configured credential. Read-only
 * probe of the exact API surface this config type writes to: GET
 * /api/v2/assurance_policy/kubernetes/<probe-name> (a 404 for a name that does not
 * exist still proves the token authenticates and the API is reachable).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheck[] = []

  const built = buildAquaClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) {
    checks.push({ name: 'credential', passed: false, message: built.error })
    return { healthy: false, score: 0, checks }
  }
  const { client } = built

  const started = Date.now()
  try {
    const res = await client.request('GET', '/api/v2/assurance_policy/kubernetes/veltrix-connectivity-probe')
    const latencyMs = Date.now() - started
    if (res.status === 401 || res.status === 403) {
      checks.push({
        name: 'aqua_authenticated',
        passed: false,
        message: `Reached the Aqua Console but authentication failed (HTTP ${res.status}). Check the Aqua user/password.`,
        latencyMs,
      })
    } else {
      const passed = res.status === 404 || (res.status > 0 && res.status < 500)
      checks.push({
        name: 'aqua_reachable',
        passed,
        message: passed
          ? `Aqua kubernetes assurance policy API reachable (HTTP ${res.status}).`
          : `Aqua Console returned HTTP ${res.status}.`,
        latencyMs,
      })
    }
  } catch (error) {
    checks.push({
      name: 'aqua_reachable',
      passed: false,
      message: `Aqua Console unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
