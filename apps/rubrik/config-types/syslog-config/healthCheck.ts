import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { rubrikConnect, getJson, resolveServiceAccount } from '../../lib/rubrikApi'

/**
 * Health for the Syslog Configuration config = the Rubrik cluster answers with
 * the service-account session AND the internal syslog endpoint is readable.
 * Read-only:
 *   1. open a service-account session (proves auth)
 *   2. GET /api/internal/syslog (proves the endpoint this config type writes is reachable)
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

    const epStarted = Date.now()
    try {
      await getJson<unknown>(conn, '/api/internal/syslog', 8000)
      checks.push({ name: 'syslog_readable', passed: true, message: 'Syslog endpoint reachable (GET /api/internal/syslog).', latencyMs: Date.now() - epStarted })
    } catch (error) {
      checks.push({ name: 'syslog_readable', passed: false, message: `Syslog query failed: ${error instanceof Error ? error.message : 'error'}`, latencyMs: Date.now() - epStarted })
    }
  } catch (error) {
    checks.push({ name: 'session', passed: false, message: `Could not establish a session: ${error instanceof Error ? error.message : 'error'}`, latencyMs: Date.now() - started })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
