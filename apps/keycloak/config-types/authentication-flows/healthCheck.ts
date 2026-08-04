import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { realmReachableHealthCheck } from '../../lib/health'

/** Health for authentication-flows = admin token accepted and the managed realm reachable. */
export default function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  return realmReachableHealthCheck(ctx)
}
