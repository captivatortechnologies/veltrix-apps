import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { validateRecords } from '../../lib/soarRecordEntities'
import { SEVERITY, buildSeverityRecord } from './_shared'

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  return validateRecords(ctx, SEVERITY, buildSeverityRecord)
}
