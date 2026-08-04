import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { deployRecords } from '../../lib/criblRecordEntities'
import { GLOBAL_VAR, buildGlobalVarRecord } from './_shared'

/** Deploy Cribl Global Variables (upsert by id) over /api/v1/m/<group>/lib/vars. */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return deployRecords(ctx, GLOBAL_VAR, buildGlobalVarRecord)
}
