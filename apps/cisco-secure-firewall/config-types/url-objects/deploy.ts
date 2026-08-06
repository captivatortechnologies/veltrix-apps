import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { runDeploy } from '../../lib/fmcPipeline'
import { URL_OBJECTS_PATH, urlObjectUpsertSpecs } from './validate'

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return runDeploy(ctx, URL_OBJECTS_PATH, urlObjectUpsertSpecs(ctx.canvas), 'URL object(s)')
}
