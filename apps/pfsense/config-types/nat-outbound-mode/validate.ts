import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { extractSpecs, OUTBOUND_NAT_MODES } from './_shared'

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const specs = extractSpecs(ctx.canvas)
  const errors: Array<{ field: string; message: string; code: string }> = []
  if (specs.length !== 1) {
    errors.push({ field: 'items', message: 'Declare exactly one outbound NAT mode.', code: 'CARDINALITY' })
  } else if (!specs[0].mode) {
    errors.push({ field: 'items[0].mode', message: `Mode must be one of: ${OUTBOUND_NAT_MODES.join(', ')}.`, code: 'INVALID_MODE' })
  }
  return { valid: errors.length === 0, errors, warnings: [] }
}
