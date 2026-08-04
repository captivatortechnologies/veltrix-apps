import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { checkGvmdReachable } from '../../lib/health'

/**
 * Health for the report-formats config = gvmd accepts a GMP connection,
 * authenticates the configured username/password and answers <get_version/>.
 * Shared with every Greenbone config type via lib/health.ts. Read-only. GMP
 * (XML over TLS, 9390). (verify_report_format — a feed-signature integrity
 * check — is a runtime action, not wired to this health check; see the app
 * README's Coverage section.)
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  return checkGvmdReachable(ctx)
}
