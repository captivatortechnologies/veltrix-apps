import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { deployRecords } from '../../lib/criblRecordEntities'
import { COLLECTOR, buildCollectorRecord } from './_shared'

/** Deploy Cribl Collectors (upsert by id) over /api/v1/m/<group>/lib/jobs. */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return deployRecords(ctx, COLLECTOR, buildCollectorRecord)
}
