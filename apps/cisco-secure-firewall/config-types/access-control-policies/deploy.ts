import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { runDeploy } from '../../lib/fmcPipeline'
import { ACCESS_POLICIES_PATH, accessControlPolicyUpsertSpecs } from './validate'

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return runDeploy(ctx, ACCESS_POLICIES_PATH, accessControlPolicyUpsertSpecs(ctx.canvas), 'access control policy/policies')
}
