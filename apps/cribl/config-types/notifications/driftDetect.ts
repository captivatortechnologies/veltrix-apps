import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { driftRecords } from '../../lib/criblRecordEntities'
import { NOTIFICATION, buildNotificationRecord } from './_shared'

/** Detect drift between declared Notifications and the live entries in Cribl. */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  return driftRecords(ctx, NOTIFICATION, buildNotificationRecord)
}
