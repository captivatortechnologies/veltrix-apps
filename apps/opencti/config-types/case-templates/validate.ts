import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate case template items: a non-empty name (>= 2 chars, matching
 * `CaseTemplateAddInput.name`'s `minLength: 2` constraint). `task_template_names`
 * is optional and structurally free-form here — whether each name resolves to a
 * live Case Task Template is checked at deploy time (network-dependent), not
 * here. Static — no target access required. The name doubles as the case
 * template identity, so a duplicate is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one case template.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Case template name is required.', code: 'EMPTY_NAME' })
    } else if (name.length < 2) {
      errors.push({
        field: `items[${i}].name`,
        message: 'Case template name must be at least 2 characters.',
        code: 'NAME_TOO_SHORT',
      })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Case template "${name}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
