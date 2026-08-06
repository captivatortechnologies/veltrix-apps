import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { runDeploy } from '../../lib/fmcPipeline'
import { PORT_OBJECTS_PATH, portObjectUpsertSpecs } from './validate'

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return runDeploy(ctx, PORT_OBJECTS_PATH, portObjectUpsertSpecs(ctx.canvas), 'port object(s)')
}
