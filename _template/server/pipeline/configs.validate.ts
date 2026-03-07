// =============================================================================
// VALIDATE HANDLER
//
// Called by the pipeline engine BEFORE approval can begin.
// Your job: check if the configuration is valid for your tool.
//
// Return { valid: true } to allow approval to proceed.
// Return { valid: false, errors: [...] } to block with specific field errors.
// Warnings are shown but don't block.
// =============================================================================

import type { PipelineContext } from '../../../server/src/core/pipeline-engine/types'
import type { ValidationResult } from '../../../shared/types/pipeline'

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  // Access the canvas data
  for (const section of ctx.canvas.sections) {
    for (const [key, value] of Object.entries(section.fields)) {
      // Example: Check required fields have values
      if (value === null || value === undefined || value === '') {
        // You'd check against your schema here
        // errors.push({ field: key, message: `${key} is required`, code: 'REQUIRED' })
      }
    }
  }

  // Example: Validate against your tool's rules
  // const nameField = ctx.canvas.sections[0]?.fields['name']
  // if (nameField && typeof nameField === 'string' && nameField.length > 255) {
  //   errors.push({
  //     field: 'name',
  //     message: 'Name must be 255 characters or less',
  //     code: 'MAX_LENGTH',
  //   })
  // }

  // Example: Add warnings for best practices
  // warnings.push({
  //   field: 'retention',
  //   message: 'Retention period is very long, consider storage costs',
  //   code: 'HIGH_RETENTION',
  // })

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}
