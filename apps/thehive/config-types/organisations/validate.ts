import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { SHARING_RULES } from './_shared'

/**
 * Validate organisation items: a non-empty name and description (both required
 * by TheHive's InputOrganisation), and a recognised sharing rule. Static — no
 * target access required. The name is the stable identity, so a duplicate name
 * is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one organisation.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const description = String(item.fields.description ?? '').trim()
    const taskRule = String(item.fields.taskRule ?? '').trim()
    const observableRule = String(item.fields.observableRule ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Organisation name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Organisation name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!description) {
      errors.push({ field: `items[${i}].description`, message: 'Organisation description is required.', code: 'EMPTY_DESCRIPTION' })
    }

    if (taskRule && !(SHARING_RULES as readonly string[]).includes(taskRule)) {
      errors.push({ field: `items[${i}].taskRule`, message: `Task sharing rule must be one of ${SHARING_RULES.join(', ')}.`, code: 'INVALID_TASK_RULE' })
    }
    if (observableRule && !(SHARING_RULES as readonly string[]).includes(observableRule)) {
      errors.push({ field: `items[${i}].observableRule`, message: `Observable sharing rule must be one of ${SHARING_RULES.join(', ')}.`, code: 'INVALID_OBSERVABLE_RULE' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
