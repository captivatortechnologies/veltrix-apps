import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { runDriftDetect } from '../../lib/fmcPipeline'
import { ACCESS_POLICIES_PATH, extractAccessControlPolicySpecs, accessControlPolicyDriftDiffs } from './validate'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const specs = extractAccessControlPolicySpecs(ctx.deployedConfig).filter((s) => s.name)
  return runDriftDetect(ctx, ACCESS_POLICIES_PATH, specs, accessControlPolicyDriftDiffs)
}
