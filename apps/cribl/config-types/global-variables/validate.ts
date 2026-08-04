import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { validateRecords } from '../../lib/criblRecordEntities'
import { GLOBAL_VAR, buildGlobalVarRecord } from './_shared'

/** Validate Global Variable items — a non-empty id, a recognized type and (if given) JSON args. Static. */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  return validateRecords(ctx, GLOBAL_VAR, buildGlobalVarRecord)
}
