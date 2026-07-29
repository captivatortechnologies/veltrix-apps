import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate Zeek log-type items: a lowercase log/analyzer name, a known state, and
 * no conflicting duplicate log types. Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Zeek log type.', code: 'EMPTY' })
  }

  const seen = new Map<string, string>()
  items.forEach((item, i) => {
    const logType = String(item.fields.logType ?? '').trim()
    const action = String(item.fields.action ?? '')

    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(logType)) {
      errors.push({ field: `items[${i}].logType`, message: `Log type must be a lowercase Zeek log name (got "${logType}").`, code: 'INVALID_LOGTYPE' })
    } else if (seen.has(logType) && seen.get(logType) !== action) {
      warnings.push({ field: `items[${i}].logType`, message: `Log type ${logType} is listed with conflicting states; the last one wins.`, code: 'CONFLICTING_LOGTYPE' })
    } else if (seen.has(logType)) {
      warnings.push({ field: `items[${i}].logType`, message: `Log type ${logType} is listed more than once.`, code: 'DUPLICATE_LOGTYPE' })
    } else {
      seen.set(logType, action)
    }

    if (action !== 'enable' && action !== 'disable') {
      errors.push({ field: `items[${i}].action`, message: `State must be "enable" or "disable" (got "${action}").`, code: 'INVALID_ACTION' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
