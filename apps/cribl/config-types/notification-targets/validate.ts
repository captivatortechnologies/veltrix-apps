import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { validateEntities } from '../../lib/criblSystemEntities'
import { NOTIFICATION_TARGET } from './_shared'

/** Validate Notification Target items — a well-formed id, a non-empty type and JSON conf. Static. */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  return validateEntities(ctx, NOTIFICATION_TARGET)
}
