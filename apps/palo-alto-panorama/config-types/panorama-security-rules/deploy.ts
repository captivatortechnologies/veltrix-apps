import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { runDeploy } from '../../lib/pipeline'
import { RESOURCE_PATH, securityRuleUpsertSpecs } from './validate'

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return runDeploy(ctx, RESOURCE_PATH, securityRuleUpsertSpecs(ctx.canvas), 'security rule(s)')
}
