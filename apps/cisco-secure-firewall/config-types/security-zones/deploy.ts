import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { runDeploy } from '../../lib/fmcPipeline'
import { SECURITY_ZONES_PATH, securityZoneUpsertSpecs } from './validate'

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return runDeploy(ctx, SECURITY_ZONES_PATH, securityZoneUpsertSpecs(ctx.canvas), 'security zone(s)')
}
