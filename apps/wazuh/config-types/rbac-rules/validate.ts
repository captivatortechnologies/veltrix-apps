import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { NAME_RE, MAX_NAME_LENGTH, specFromItem } from './_shared'

/**
 * Validate RBAC-rule items: a safe RBAC name and a rule definition that parses
 * as a non-empty JSON object. The FIND/MATCH grammar itself is not independently
 * re-validated — an invalid condition tree surfaces a clear error from Wazuh at
 * deploy time. Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one RBAC rule.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const spec = specFromItem(item)

    if (!spec.name) {
      errors.push({ field: `items[${i}].name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    } else if (spec.name.length > MAX_NAME_LENGTH || !NAME_RE.test(spec.name)) {
      errors.push({ field: `items[${i}].name`, message: `Name "${spec.name}" must be at most ${MAX_NAME_LENGTH} characters, using only letters, numbers, dot, underscore, percent or hyphen.`, code: 'INVALID_NAME' })
    } else if (seen.has(spec.name)) {
      warnings.push({ field: `items[${i}].name`, message: `Rule ${spec.name} is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(spec.name)
    }

    if (spec.ruleParseError) {
      errors.push({ field: `items[${i}].ruleDefinition`, message: `Rule definition is not valid (${spec.ruleParseError}). Provide a JSON object, e.g. {"FIND": {"username": "admin"}}.`, code: 'INVALID_RULE_JSON' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
