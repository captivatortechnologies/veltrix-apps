import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { runHealthCheck } from '../../lib/fmcPipeline'
import { URL_OBJECTS_PATH, extractUrlObjectSpecs } from './validate'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const names = extractUrlObjectSpecs(ctx.canvas).filter((s) => s.name).map((s) => s.name)
  return runHealthCheck(ctx, URL_OBJECTS_PATH, names, 'url-object')
}
