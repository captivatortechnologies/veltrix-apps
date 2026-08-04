import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { POLICY_TYPES } from './_shared'

/**
 * Validate authentik Policy items: a non-empty name (the upsert identity
 * within the item's type), a known type, and — only for Type = expression —
 * a required expression (the only type-specific required field beyond `name`
 * per the ExpressionPolicyRequest/PasswordPolicyRequest/ReputationPolicyRequest
 * schemas). Static (no target access, no expression execution/linting).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one policy.', code: 'EMPTY' })
  }

  const seenByType = new Map<string, Set<string>>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const type = String(item.fields.type ?? '').trim()
    const expression = String(item.fields.expression ?? '')

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Policy name is required.', code: 'EMPTY_NAME' })
    }

    if (!type) {
      errors.push({ field: `items[${i}].type`, message: 'Policy type is required.', code: 'EMPTY_TYPE' })
    } else if (!POLICY_TYPES.has(type)) {
      errors.push({ field: `items[${i}].type`, message: `Unsupported policy type "${type}".`, code: 'INVALID_TYPE' })
    }

    if (type === 'expression' && !expression.trim()) {
      errors.push({ field: `items[${i}].expression`, message: 'Expression is required for a Type = Expression policy.', code: 'EMPTY_EXPRESSION' })
    }

    if (name && type) {
      const key = `${type}:${name}`
      const seen = seenByType.get(type) ?? new Set<string>()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].name`, message: `Policy "${name}" (${type}) is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      }
      seen.add(key)
      seenByType.set(type, seen)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
