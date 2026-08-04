import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { deployRecords } from '../../lib/criblRecordEntities'
import { NOTIFICATION, buildNotificationRecord } from './_shared'

/** Deploy Cribl Notifications (upsert by id) over /api/v1/notifications. */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  return deployRecords(ctx, NOTIFICATION, buildNotificationRecord)
}
