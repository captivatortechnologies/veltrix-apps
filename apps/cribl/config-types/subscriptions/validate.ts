import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { validateRecords } from '../../lib/criblRecordEntities'
import { SUBSCRIPTION, buildSubscriptionRecord } from './_shared'

/** Validate Subscription items — a non-empty id and target pipeline. Static. */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  return validateRecords(ctx, SUBSCRIPTION, buildSubscriptionRecord)
}
