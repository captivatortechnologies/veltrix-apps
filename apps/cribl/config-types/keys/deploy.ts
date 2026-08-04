import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { deployRecords } from '../../lib/criblRecordEntities'
import { KEY, buildKeyRecord } from './_shared'

/** Deploy Cribl Key metadata (upsert by keyId) over /api/v1/m/<group>/system/keys. */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return deployRecords(ctx, KEY, buildKeyRecord)
}
