import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { runHealthCheck } from '../../lib/fmcPipeline'
import { extractNetworkGroupSpecs, NETWORK_GROUPS_PATH } from './validate'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const names = extractNetworkGroupSpecs(ctx.canvas).filter((s) => s.name).map((s) => s.name)
  return runHealthCheck(ctx, NETWORK_GROUPS_PATH, names, 'network-group')
}
