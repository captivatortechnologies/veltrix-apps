import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { runDeploy } from '../../lib/pipeline'
import { RESOURCE_PATH, serviceGroupUpsertSpecs } from './validate'

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return runDeploy(ctx, RESOURCE_PATH, serviceGroupUpsertSpecs(ctx.canvas), 'service group(s)')
}
