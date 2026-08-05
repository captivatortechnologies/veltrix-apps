import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { validateRecords } from '../../lib/soarRecordEntities'
import { CONTAINER_STATUS, buildStatusRecord } from './_shared'

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const result = validateRecords(ctx, CONTAINER_STATUS, buildStatusRecord)
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  if (items.length > 30) {
    result.warnings.push({
      field: 'items',
      message: `SOAR allows at most 30 total status labels (default + custom); this canvas alone declares ${items.length}.`,
      code: 'TOO_MANY',
    })
  }
  return result
}
