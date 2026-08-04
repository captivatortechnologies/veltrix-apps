import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { deployRecords } from '../../lib/criblRecordEntities'
import { SCHEMA, buildSchemaRecord } from './_shared'

/** Deploy Cribl Schemas (upsert by id) over /api/v1/m/<group>/lib/schemas. */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return deployRecords(ctx, SCHEMA, buildSchemaRecord)
}
