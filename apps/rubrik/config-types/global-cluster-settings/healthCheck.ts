import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { rubrikConnect, getJson, resolveServiceAccount } from '../../lib/rubrikApi'

/**
 * Health for the Global Cluster Settings config = the Rubrik cluster answers
 * with the service-account session AND the v1 cluster endpoint is readable.
 * Read-only:
 *   1. open a service-account session (proves auth)
 *   2. GET /api/v1/cluster/me (proves the endpoint this config type writes is reachable)
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, settings } = ctx
  const checks: HealthCheck[] = []

  if (!resolveServiceAccount(credential)) {
    checks.push({ name: 'credential', passed: false, message: 'No Rubrik service-account credential attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const started = Date.now()
  try {
    const conn = await rubrikConnect(component, credential, settings)
    checks.push({ name: 'session', passed: true, message: 'Service-account session established.', latencyMs: Date.now() - started })

    const clusterStarted = Date.now()
    try {
      await getJson<{ id?: string; name?: string }>(conn, '/api/v1/cluster/me', 8000)
      checks.push({ name: 'cluster_settings_readable', passed: true, message: 'Cluster settings endpoint reachable (GET /api/v1/cluster/me).', latencyMs: Date.now() - clusterStarted })
    } catch (error) {
      checks.push({ name: 'cluster_settings_readable', passed: false, message: `Cluster settings query failed: ${error instanceof Error ? error.message : 'error'}`, latencyMs: Date.now() - clusterStarted })
    }
  } catch (error) {
    checks.push({ name: 'session', passed: false, message: `Could not establish a session: ${error instanceof Error ? error.message : 'error'}`, latencyMs: Date.now() - started })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
