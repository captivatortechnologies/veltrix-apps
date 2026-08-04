import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

const HEX_COLOUR = /^#[0-9A-Fa-f]{6}$/

/**
 * Validate tag items: a non-empty name and, when provided, a valid hex colour.
 * Static — no target access required. The name doubles as the tag identity
 * (MISP enforces name uniqueness), so a duplicate name is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one tag.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const colour = String(item.fields.colour ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Tag name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name.toLowerCase())) {
      warnings.push({ field: `items[${i}].name`, message: `Tag name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name.toLowerCase())
    }

    if (colour && !HEX_COLOUR.test(colour)) {
      errors.push({ field: `items[${i}].colour`, message: `Colour must be a hex value like #ffce3d (got "${colour}").`, code: 'INVALID_COLOUR' })
    }

    const numericalValue = item.fields.numerical_value
    if (numericalValue !== undefined && numericalValue !== '' && !Number.isFinite(Number(numericalValue))) {
      errors.push({ field: `items[${i}].numerical_value`, message: 'Numerical value must be a number.', code: 'INVALID_NUMBER' })
    }

    for (const key of ['org_id', 'user_id'] as const) {
      const value = item.fields[key]
      if (value !== undefined && value !== '' && (!Number.isFinite(Number(value)) || Number(value) < 0)) {
        errors.push({ field: `items[${i}].${key}`, message: `${key === 'org_id' ? 'Organisation' : 'User'} ID must be a non-negative number.`, code: 'INVALID_NUMBER' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
