import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { soarHealthCheck } from '../../lib/soarRecordEntities'

/** Every SOAR config type shares the same health probe (GET /rest/version). */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  return soarHealthCheck(ctx)
}
