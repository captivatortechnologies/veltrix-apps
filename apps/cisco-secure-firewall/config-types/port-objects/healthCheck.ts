import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { runHealthCheck } from '../../lib/fmcPipeline'
import { PORT_OBJECTS_PATH, extractPortObjectSpecs } from './validate'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const names = extractPortObjectSpecs(ctx.canvas).filter((s) => s.name).map((s) => s.name)
  return runHealthCheck(ctx, PORT_OBJECTS_PATH, names, 'port-object')
}
