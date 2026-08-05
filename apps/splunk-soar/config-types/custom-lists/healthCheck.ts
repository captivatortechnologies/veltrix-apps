import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { soarHealthCheck } from '../../lib/soarRecordEntities'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  return soarHealthCheck(ctx)
}
