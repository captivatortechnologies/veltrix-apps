import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { deployRecords } from '../../lib/criblRecordEntities'
import { LOOKUP, buildLookupRecord } from './_shared'

/** Deploy Cribl Lookups (upsert by id) over /api/v1/m/<group>/system/lookups. */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return deployRecords(ctx, LOOKUP, buildLookupRecord)
}
