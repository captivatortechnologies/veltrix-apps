import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { validateEntities } from '../../lib/criblSystemEntities'
import { SOURCE } from './_shared'

/** Validate Source items — a well-formed id, a non-empty type and JSON conf. Static. */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  return validateEntities(ctx, SOURCE)
}
