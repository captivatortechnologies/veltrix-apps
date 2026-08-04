import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { getOneToManyNatRules } from '../../lib/merakiApi'
import { healthCheckOrderedList } from '../../lib/merakiOrderedList'

/** Health check for one-to-many NAT rules — thin wrapper over the shared ordered-list engine. */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  return healthCheckOrderedList(ctx, { get: getOneToManyNatRules })
}
