import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { runDriftDetect } from '../../lib/pipeline'
import { RESOURCE_PATH, extractAddressSpecs, addressDriftDiffs } from './validate'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const specs = extractAddressSpecs(ctx.deployedConfig).filter((s) => s.name)
  return runDriftDetect(ctx, RESOURCE_PATH, specs, addressDriftDiffs)
}
