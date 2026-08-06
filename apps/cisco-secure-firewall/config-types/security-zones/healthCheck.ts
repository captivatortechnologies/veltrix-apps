import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { runHealthCheck } from '../../lib/fmcPipeline'
import { SECURITY_ZONES_PATH, extractSecurityZoneSpecs } from './validate'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const names = extractSecurityZoneSpecs(ctx.canvas).filter((s) => s.name).map((s) => s.name)
  return runHealthCheck(ctx, SECURITY_ZONES_PATH, names, 'security-zone')
}
