import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { runDriftDetect } from '../../lib/fmcPipeline'
import { PORT_OBJECTS_PATH, extractPortObjectSpecs, portObjectDriftDiffs } from './validate'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const specs = extractPortObjectSpecs(ctx.deployedConfig).filter((s) => s.name)
  return runDriftDetect(ctx, PORT_OBJECTS_PATH, specs, portObjectDriftDiffs)
}
