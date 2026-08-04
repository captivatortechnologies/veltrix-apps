import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { validateRecords } from '../../lib/criblRecordEntities'
import { PARSER, buildParserRecord } from './_shared'

/** Validate Parser items — a non-empty id and a recognized parser type. Static. */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  return validateRecords(ctx, PARSER, buildParserRecord)
}
