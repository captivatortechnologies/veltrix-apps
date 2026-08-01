import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate secret policy items: a non-empty policy name (its identity). Static —
 * no target access required. A policy's identity is its name, so a duplicate
 * name is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one secret policy.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.secretPolicyName ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].secretPolicyName`, message: 'Policy name is required.', code: 'EMPTY_NAME' })
      return
    }
    if (name.length > 255) {
      errors.push({ field: `items[${i}].secretPolicyName`, message: `Policy name "${name}" exceeds 255 characters.`, code: 'NAME_TOO_LONG' })
    }

    const key = name.toLowerCase()
    if (seen.has(key)) {
      warnings.push({
        field: `items[${i}].secretPolicyName`,
        message: `Secret policy "${name}" is listed more than once; the last one wins.`,
        code: 'DUPLICATE_POLICY',
      })
    } else {
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
