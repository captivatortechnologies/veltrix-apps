import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { toCapacityBytes } from './_shared'

const RESET_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * Validate ingest-budget items: a non-empty name and scope, a positive
 * capacity, and a valid action. Static — no target access required. The name is
 * the identity, so a duplicate is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one ingest budget.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const scope = String(item.fields.scope ?? '').trim()
    const action = String(item.fields.action ?? '').trim()
    const resetTime = String(item.fields.resetTime ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Budget name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Budget name "${name}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }

    if (!scope) {
      errors.push({ field: `items[${i}].scope`, message: 'Scope is required (e.g. _sourceCategory=*prod*nginx*).', code: 'EMPTY_SCOPE' })
    }

    if (toCapacityBytes(item.fields.capacityBytes) === undefined) {
      errors.push({ field: `items[${i}].capacityBytes`, message: 'Capacity must be a positive whole number of bytes.', code: 'INVALID_CAPACITY' })
    }

    if (action && action !== 'stopCollecting' && action !== 'keepCollecting') {
      errors.push({ field: `items[${i}].action`, message: 'Action must be stopCollecting or keepCollecting.', code: 'INVALID_ACTION' })
    }

    if (resetTime && !RESET_TIME_RE.test(resetTime)) {
      errors.push({ field: `items[${i}].resetTime`, message: 'Reset time must be in HH:MM 24-hour format.', code: 'INVALID_RESET_TIME' })
    }

    if (action === 'stopCollecting') {
      warnings.push({
        field: `items[${i}].action`,
        message: `Budget "${name || i}" will stop Collectors from sending data once capacity is reached — verify this is intentional.`,
        code: 'STOP_COLLECTING_IMPACT',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
