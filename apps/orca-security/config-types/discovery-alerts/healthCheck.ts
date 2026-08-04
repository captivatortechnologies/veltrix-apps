import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildOrcaClient } from '../../lib/orcaApi'

/**
 * Health for discovery alerts = Orca answers on its REST API with the
 * configured API token. Read-only probe: GET /api/alerts/catalog/category (a
 * small authenticated payload). A 2xx proves the token is accepted for this
 * tenant.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheck[] = []

  const built = buildOrcaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    checks.push({ name: 'credential', passed: false, message: built.error })
    return { healthy: false, score: 0, checks }
  }
  const { client, baseUrl } = built

  const started = Date.now()
  const res = await client.request('GET', '/api/alerts/catalog/category')
  const passed = res.ok
  checks.push({
    name: 'orca_reachable',
    passed,
    message: passed
      ? `Orca reachable and authenticated (${baseUrl}).`
      : `Orca probe failed: ${res.error ?? `HTTP ${res.status}`}.`,
    latencyMs: Date.now() - started,
  })

  const ok = checks.filter((c) => c.passed).length
  return { healthy: ok === checks.length, score: checks.length ? ok / checks.length : 0, checks }
}
