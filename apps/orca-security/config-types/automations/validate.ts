import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { STATUSES } from './_shared'
import { parseJsonField } from '../../lib/reconcile'

/**
 * Validate automation items: a non-empty name (the identity), a known status, a
 * Sonar query that parses as a JSON object and an action list that parses as a
 * non-empty JSON array. Static — no target access required. A duplicate name is
 * flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one automation.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const status = String(item.fields.status ?? '').trim().toLowerCase()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Automation name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Automation name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (status && !STATUSES.has(status)) {
      errors.push({ field: `items[${i}].status`, message: `Status must be "enabled" or "disabled" (got "${status}").`, code: 'INVALID_STATUS' })
    }

    const query = parseJsonField(item.fields.sonarQuery, 'Sonar query')
    if (!query.ok) {
      errors.push({ field: `items[${i}].sonarQuery`, message: query.error, code: 'INVALID_SONAR_QUERY' })
    } else if (!query.value || typeof query.value !== 'object' || Array.isArray(query.value)) {
      errors.push({ field: `items[${i}].sonarQuery`, message: 'Sonar query must be a JSON object.', code: 'INVALID_SONAR_QUERY' })
    }

    const actions = parseJsonField(item.fields.actions, 'Actions')
    if (!actions.ok) {
      errors.push({ field: `items[${i}].actions`, message: actions.error, code: 'INVALID_ACTIONS' })
    } else if (!Array.isArray(actions.value) || actions.value.length === 0) {
      errors.push({ field: `items[${i}].actions`, message: 'Actions must be a non-empty JSON array.', code: 'INVALID_ACTIONS' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
