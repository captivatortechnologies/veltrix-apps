import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { validateRecords } from '../../lib/soarRecordEntities'
import { CEF, buildCefRecord } from './_shared'

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  return validateRecords(ctx, CEF, buildCefRecord)
}
