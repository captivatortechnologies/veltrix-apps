import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { validateRecords } from '../../lib/criblRecordEntities'
import { NOTIFICATION, buildNotificationRecord } from './_shared'

/** Validate Notification items — a non-empty id and condition, valid conf/metadata JSON. Static. */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  return validateRecords(ctx, NOTIFICATION, buildNotificationRecord)
}
