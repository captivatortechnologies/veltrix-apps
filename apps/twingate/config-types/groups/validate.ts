import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { extractGroupSpecs, groupKey } from './_shared'

/**
 * Validate Twingate Group configurations: name is required and must be
 * unique across the canvas (case-insensitive). Purely static: no live
 * Twingate calls — Resource NAME resolution (for `resource_names`) happens at
 * deploy/drift time, against the live tenant.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Canvas has no configuration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractGroupSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.itemName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Group name is required', code: 'required' })
    }

    if (spec.name) {
      const key = groupKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate Group "${spec.name}" — each name may only be declared once`,
          code: 'duplicate_group',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
