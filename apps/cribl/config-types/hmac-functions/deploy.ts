import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { deployRecords } from '../../lib/criblRecordEntities'
import { HMAC_FUNCTION, buildHmacFunctionRecord } from './_shared'

/** Deploy Cribl HMAC Functions (upsert by id) over /api/v1/m/<group>/lib/hmac-functions. */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return deployRecords(ctx, HMAC_FUNCTION, buildHmacFunctionRecord)
}
