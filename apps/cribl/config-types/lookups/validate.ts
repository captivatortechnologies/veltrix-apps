import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { validateRecords } from '../../lib/criblRecordEntities'
import { LOOKUP, buildLookupRecord } from './_shared'

/** Validate Lookup items — a filename-shaped id and non-empty content. Static. */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  return validateRecords(ctx, LOOKUP, buildLookupRecord)
}
