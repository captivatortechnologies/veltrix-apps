import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { validateRecords } from '../../lib/criblRecordEntities'
import { GROK, buildGrokRecord } from './_shared'

/** Validate Grok Pattern File items — a non-empty id and content. Static. */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  return validateRecords(ctx, GROK, buildGrokRecord)
}
