import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { validateRecords } from '../../lib/criblRecordEntities'
import { HMAC_FUNCTION, buildHmacFunctionRecord } from './_shared'

/** Validate HMAC Function items — a non-empty id, header name/expression and at least one string builder. Static. */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  return validateRecords(ctx, HMAC_FUNCTION, buildHmacFunctionRecord)
}
