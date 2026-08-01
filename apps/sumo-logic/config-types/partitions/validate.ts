import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { toRetentionDays } from './_shared'

/**
 * Validate partition items: a non-empty name and a non-empty routing expression.
 * Static — no target access required. The partition name is the identity, so a
 * duplicate name is flagged (last one wins). Retention, when supplied, must be a
 * whole number of days >= -1 (-1 = account default).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one partition.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const routingExpression = String(item.fields.routingExpression ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Partition name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Partition name "${name}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }

    if (!routingExpression) {
      errors.push({
        field: `items[${i}].routingExpression`,
        message: 'Routing expression is required (e.g. _sourceCategory=prod/nginx).',
        code: 'EMPTY_ROUTING_EXPRESSION',
      })
    }

    const rawRetention = item.fields.retentionPeriod
    if (rawRetention !== '' && rawRetention !== null && rawRetention !== undefined) {
      const days = toRetentionDays(rawRetention)
      if (days === undefined) {
        errors.push({
          field: `items[${i}].retentionPeriod`,
          message: 'Retention period must be a whole number of days (or -1 for the account default).',
          code: 'INVALID_RETENTION',
        })
      } else if (days < -1) {
        errors.push({
          field: `items[${i}].retentionPeriod`,
          message: 'Retention period cannot be less than -1.',
          code: 'INVALID_RETENTION',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
