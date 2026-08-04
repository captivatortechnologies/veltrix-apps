import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { validateRecords } from '../../lib/criblRecordEntities'
import { KEY, buildKeyRecord } from './_shared'

/** Validate Key items — a non-empty id and a recognized algorithm. Static. */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  return validateRecords(ctx, KEY, buildKeyRecord)
}
