import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { realmReachableHealthCheck } from '../../lib/health'

/**
 * Health for user-federation = admin token accepted and the managed realm
 * reachable. Keycloak's specialized component test-connection/test-
 * authentication endpoints (used by the Admin Console's "Test connection" /
 * "Test authentication" buttons on an LDAP provider) are NOT used here — that
 * is a documented follow-up, not built in this pass.
 */
export default function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  return realmReachableHealthCheck(ctx)
}
