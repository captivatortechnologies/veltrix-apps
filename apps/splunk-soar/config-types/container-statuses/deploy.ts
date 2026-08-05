import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { deployRecords } from '../../lib/soarRecordEntities'
import { CONTAINER_STATUS, buildStatusRecord } from './_shared'

/** Deploy Container Statuses (upsert by name) over GET/POST /rest/container_status. */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return deployRecords(ctx, CONTAINER_STATUS, buildStatusRecord)
}
