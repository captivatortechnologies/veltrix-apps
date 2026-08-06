import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { runDriftDetect } from '../../lib/fmcPipeline'
import { URL_OBJECTS_PATH, extractUrlObjectSpecs, urlObjectDriftDiffs } from './validate'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const specs = extractUrlObjectSpecs(ctx.deployedConfig).filter((s) => s.name)
  return runDriftDetect(ctx, URL_OBJECTS_PATH, specs, urlObjectDriftDiffs)
}
