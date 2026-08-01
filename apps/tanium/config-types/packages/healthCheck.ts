import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { taniumReachableHealth } from '../../lib/taniumHealth'

/** Health for packages config = Tanium authenticates + answers on REST v2. */
export default function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  return taniumReachableHealth(ctx)
}
