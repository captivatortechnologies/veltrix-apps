import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { healthTable } from '../../lib/tableConfig'
import { spec } from './_shared'

/** Health = the instance answers a read of sys_ui_action with the configured credential. */
export default function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  return healthTable(ctx, spec)
}
