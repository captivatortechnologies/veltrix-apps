import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { runHealthCheck } from '../../lib/fmcPipeline'
import { extractPortGroupSpecs, PORT_GROUPS_PATH } from './validate'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const names = extractPortGroupSpecs(ctx.canvas).filter((s) => s.name).map((s) => s.name)
  return runHealthCheck(ctx, PORT_GROUPS_PATH, names, 'port-group')
}
