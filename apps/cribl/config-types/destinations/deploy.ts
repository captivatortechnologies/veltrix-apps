import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { deployEntities } from '../../lib/criblSystemEntities'
import { DESTINATION } from './_shared'

/** Deploy Cribl Destinations (upsert by id) over /api/v1/m/<group>/system/outputs. */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return deployEntities(ctx, DESTINATION)
}
