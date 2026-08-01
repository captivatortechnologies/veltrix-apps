import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildAdminClient, resolveGrant, resolveRealm } from '../../lib/keycloakApi'

/**
 * Health for clients config = Keycloak issues an admin token AND the managed realm
 * answers the Admin REST API. Read-only: GET /admin/realms/{realm} (relative path
 * "" off the realm base). A 2xx means the token was accepted and the realm is
 * reachable.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, connectivityProvider, settings } = ctx
  const checks: HealthCheck[] = []

  if (!resolveGrant(credential)) {
    checks.push({ name: 'credential', passed: false, message: 'No usable admin credential on this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const admin = buildAdminClient({ component, connectivity, connectivityProvider, credential, settings })
  const realm = resolveRealm(settings)
  const started = Date.now()
  try {
    const res = await admin.get('')
    const passed = res.ok
    checks.push({
      name: 'keycloak_realm_reachable',
      passed,
      message: passed
        ? `Keycloak realm "${realm}" reachable and admin token accepted (HTTP ${res.status}).`
        : `Keycloak realm "${realm}" check returned HTTP ${res.status}: ${res.body.slice(0, 200)}`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'keycloak_realm_reachable',
      passed: false,
      message: `Keycloak unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
