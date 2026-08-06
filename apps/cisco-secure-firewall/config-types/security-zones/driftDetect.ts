import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { runDriftDetect } from '../../lib/fmcPipeline'
import { SECURITY_ZONES_PATH, extractSecurityZoneSpecs, securityZoneDriftDiffs } from './validate'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const specs = extractSecurityZoneSpecs(ctx.deployedConfig).filter((s) => s.name)
  return runDriftDetect(ctx, SECURITY_ZONES_PATH, specs, securityZoneDriftDiffs)
}
