import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { runDeploy } from '../../lib/pipeline'
import { RESOURCE_PATH, addressUpsertSpecs } from './validate'

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return runDeploy(ctx, RESOURCE_PATH, addressUpsertSpecs(ctx.canvas), 'address object(s)')
}
