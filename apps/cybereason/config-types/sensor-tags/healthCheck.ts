import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildCybereasonUrl, createSession, resolveTimeoutMs, looksLikeLoginPage, CybereasonAuthError } from '../../lib/cybereasonApi'
import { SENSORS_QUERY_ENDPOINT } from './_shared'

/**
 * Health for sensor tags = Cybereason accepts the session-cookie login and
 * answers an authenticated, bounded POST /rest/sensors/query (limit 1, no
 * filters) — the read side of this config type's write path.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const checks: HealthCheck[] = []

  if (!credential) {
    checks.push({ name: 'credential', passed: false, message: 'No credential attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const base = buildCybereasonUrl(component, connectivity, connectivityProvider)
  const timeoutMs = resolveTimeoutMs(settings, 8000)
  const started = Date.now()
  try {
    const session = await createSession(base, credential, timeoutMs)
    const res = await session.postJson(SENSORS_QUERY_ENDPOINT, { filters: [], limit: 1, offset: 0, sortDirection: 'ASC' })
    const passed = res.ok && !looksLikeLoginPage(res.body)
    checks.push({
      name: 'cybereason_reachable',
      passed,
      message: passed
        ? `Cybereason reachable and authenticated (HTTP ${res.status}).`
        : `Cybereason session did not authenticate (HTTP ${res.status}).`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    const isAuth = error instanceof CybereasonAuthError
    checks.push({
      name: 'cybereason_reachable',
      passed: false,
      message: isAuth
        ? `Cybereason authentication failed: ${error.message}`
        : `Cybereason unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
