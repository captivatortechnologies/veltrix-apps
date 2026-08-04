import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { deployRecords } from '../../lib/criblRecordEntities'
import { DATABASE_CONNECTION, buildDatabaseConnectionRecord } from './_shared'

/** Deploy Cribl Database Connections (upsert by id) over /api/v1/m/<group>/lib/database-connections. */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return deployRecords(ctx, DATABASE_CONNECTION, buildDatabaseConnectionRecord)
}
