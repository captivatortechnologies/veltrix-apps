import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { runDriftDetect } from '../../lib/pipeline'
import { RESOURCE_PATH, extractServiceGroupSpecs, serviceGroupDriftDiffs } from './validate'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const specs = extractServiceGroupSpecs(ctx.deployedConfig).filter((s) => s.name)
  return runDriftDetect(ctx, RESOURCE_PATH, specs, serviceGroupDriftDiffs)
}
