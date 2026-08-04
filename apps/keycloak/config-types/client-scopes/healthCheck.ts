import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { realmReachableHealthCheck } from '../../lib/health'

/** Health for client-scopes = admin token accepted and the managed realm reachable. */
export default function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  return realmReachableHealthCheck(ctx)
}
