import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate observable-type items: a non-empty name. Static — no target access
 * required. The type name is the stable identity, so a duplicate name is flagged
 * (last one wins). Whitespace inside a name is warned — TheHive observable type
 * names are compact tokens (e.g. ip, domain, filename).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one observable type.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Observable type name is required.', code: 'EMPTY_NAME' })
      return
    }
    if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Observable type "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }
    if (/\s/.test(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Observable type "${name}" contains whitespace — TheHive type names are usually compact tokens (e.g. ip, domain, filename).`, code: 'NAME_WHITESPACE' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
