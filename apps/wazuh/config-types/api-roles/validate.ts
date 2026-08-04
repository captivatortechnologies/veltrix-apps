import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { NAME_RE, MAX_NAME_LENGTH, specFromItem } from './_shared'

/**
 * Validate API-role items: a safe RBAC name. Whether the declared policy/rule
 * NAMEs actually exist requires a live lookup, so that is checked at deploy
 * time (an unresolvable name fails that item's deploy with the full list of
 * missing names) rather than here. Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one API role.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const spec = specFromItem(item)

    if (!spec.name) {
      errors.push({ field: `items[${i}].name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    } else if (spec.name.length > MAX_NAME_LENGTH || !NAME_RE.test(spec.name)) {
      errors.push({ field: `items[${i}].name`, message: `Name "${spec.name}" must be at most ${MAX_NAME_LENGTH} characters, using only letters, numbers, dot, underscore, percent or hyphen.`, code: 'INVALID_NAME' })
    } else if (seen.has(spec.name)) {
      warnings.push({ field: `items[${i}].name`, message: `Role ${spec.name} is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(spec.name)
    }

    if (spec.policyNames.length === 0 && spec.ruleNames.length === 0) {
      warnings.push({ field: `items[${i}].policies`, message: 'This role has no policies or RBAC rules attached — it will grant no permissions.', code: 'NO_PERMISSIONS' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
