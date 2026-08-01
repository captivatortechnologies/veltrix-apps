import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { ACTION_TYPE_BY_KEY, normalizeSeverity, splitList } from './_shared'

/**
 * Validate runtime-policy items: a non-empty unique name, at least one
 * referenced rule name, a severity in the 0–7 range and known response actions.
 * Static — no target access required. The policy name is the stable identity,
 * so a duplicate name is flagged (last one wins on deploy).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one runtime policy.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const ruleNames = splitList(item.fields.ruleNames)
    const severity = normalizeSeverity(item.fields.severity)
    const actions = splitList(item.fields.actions)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Policy name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Policy name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (ruleNames.length === 0) {
      errors.push({ field: `items[${i}].ruleNames`, message: 'A policy must reference at least one rule name.', code: 'EMPTY_RULE_NAMES' })
    }

    if (!Number.isInteger(severity) || severity < 0 || severity > 7) {
      errors.push({
        field: `items[${i}].severity`,
        message: `Severity must be an integer 0–7 (got "${String(item.fields.severity)}").`,
        code: 'INVALID_SEVERITY',
      })
    }

    for (const action of actions) {
      if (!ACTION_TYPE_BY_KEY[action.toLowerCase()]) {
        errors.push({
          field: `items[${i}].actions`,
          message: `Response action must be one of ${Object.keys(ACTION_TYPE_BY_KEY).join(', ')} (got "${action}").`,
          code: 'INVALID_ACTION',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
