import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { criblHealthCheck } from '../../lib/criblCommon'

/** Health for Worker Group Settings = Cribl authenticates and answers on its REST API. */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  return criblHealthCheck(ctx)
}
