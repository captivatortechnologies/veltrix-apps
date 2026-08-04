import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { validateRecords } from '../../lib/criblRecordEntities'
import { REGEX, buildRegexRecord } from './_shared'

/** Validate Regex Library items — a non-empty id and pattern. Static. */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  return validateRecords(ctx, REGEX, buildRegexRecord)
}
