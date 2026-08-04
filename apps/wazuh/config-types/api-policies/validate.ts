import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { NAME_RE, MAX_NAME_LENGTH, ACTION_RE, isValidResource, specFromItem } from './_shared'

/**
 * Validate API-policy items: a safe RBAC name, at least one action matching
 * Wazuh's `<resource-type>:<verb>` grammar, and at least one resource matching
 * `<type>:<attribute>:<value>` (optionally `&`-combined). Static — no target
 * access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one API policy.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const spec = specFromItem(item)

    if (!spec.name) {
      errors.push({ field: `items[${i}].name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    } else if (spec.name.length > MAX_NAME_LENGTH || !NAME_RE.test(spec.name)) {
      errors.push({ field: `items[${i}].name`, message: `Name "${spec.name}" must be at most ${MAX_NAME_LENGTH} characters, using only letters, numbers, dot, underscore, percent or hyphen.`, code: 'INVALID_NAME' })
    } else if (seen.has(spec.name)) {
      warnings.push({ field: `items[${i}].name`, message: `Policy ${spec.name} is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(spec.name)
    }

    if (spec.actions.length === 0) {
      errors.push({ field: `items[${i}].actions`, message: 'At least one action is required.', code: 'EMPTY_ACTIONS' })
    } else {
      const bad = spec.actions.filter((a) => !ACTION_RE.test(a))
      if (bad.length) {
        errors.push({ field: `items[${i}].actions`, message: `Invalid action(s): ${bad.join(', ')}. Expected "<resource-type>:<verb>", e.g. "agent:read".`, code: 'INVALID_ACTION' })
      }
    }

    if (spec.resources.length === 0) {
      errors.push({ field: `items[${i}].resources`, message: 'At least one resource is required.', code: 'EMPTY_RESOURCES' })
    } else {
      const bad = spec.resources.filter((r) => !isValidResource(r))
      if (bad.length) {
        errors.push({ field: `items[${i}].resources`, message: `Invalid resource(s): ${bad.join(', ')}. Expected "<type>:<attribute>:<value>", e.g. "agent:id:*".`, code: 'INVALID_RESOURCE' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
