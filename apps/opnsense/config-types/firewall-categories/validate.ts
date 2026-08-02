import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { categoryKey, extractCategorySpecs, isValidColor, type CategorySpec } from './_shared'

/**
 * Validate OPNsense firewall-category configurations: a required, unique
 * (case-sensitive) name that contains no comma (Category.xml's own Mask
 * `/[^,]+/` — categories are stored comma-joined wherever they're
 * referenced, so a comma in a name would corrupt every reference), and an
 * optional 6-hex-digit color.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const items = ctx.canvas.items ?? ctx.canvas.sections
  if (!items || items.length === 0) {
    errors.push({ field: 'items', message: 'Canvas has no configuration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs: CategorySpec[] = extractCategorySpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.includes(',')) {
        errors.push({
          field: `${prefix}.name`,
          message: 'Name must not contain a comma — categories are stored as a comma-separated list wherever they are referenced',
          code: 'invalid_name',
        })
      }
      const key = categoryKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate category "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seen.add(key)
    }

    if (!isValidColor(spec.color)) {
      errors.push({
        field: `${prefix}.color`,
        message: `"${spec.color}" is not a valid color — use 6 hex digits (e.g. FF8800), or leave blank`,
        code: 'invalid_color',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
