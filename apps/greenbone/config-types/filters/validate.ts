import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate filter items: a non-empty name. Type and term are both optional in
 * GMP (an empty term is a legal match-all filter). Static — no gvmd access
 * required. Filter names double as the upsert identity, so a duplicate name is
 * flagged (last one wins) — matching this app's existing name-based config
 * types, even though gvmd itself enforces even less name uniqueness here.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one filter.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Filter name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Filter name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
