import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import {
  buildCybereasonUrl,
  createSession,
  resolveTimeoutMs,
  looksLikeLoginPage,
  CybereasonAuthError,
  CLASSIFICATION_DOWNLOAD_PATH,
} from '../../lib/cybereasonApi'

/**
 * Health for reputations config = Cybereason accepts the session-cookie login and
 * answers an authenticated read. The login proves the username/password; the
 * bounded GET /rest/classification/download proves the session carries API access.
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
    const res = await session.get(CLASSIFICATION_DOWNLOAD_PATH)
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
