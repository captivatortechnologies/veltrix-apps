import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { deployRecords } from '../../lib/criblRecordEntities'
import { SECRET, buildSecretRecord } from './_shared'

/** Deploy Cribl Secrets (upsert by id) over /api/v1/m/<group>/system/secrets. */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return deployRecords(ctx, SECRET, buildSecretRecord)
}
