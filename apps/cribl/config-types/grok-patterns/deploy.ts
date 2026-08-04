import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { deployRecords } from '../../lib/criblRecordEntities'
import { GROK, buildGrokRecord } from './_shared'

/** Deploy Cribl Grok Pattern Files (upsert by id) over /api/v1/m/<group>/lib/grok. */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return deployRecords(ctx, GROK, buildGrokRecord)
}
