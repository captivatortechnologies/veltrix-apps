import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate Suricata rule items: numeric SID, a known state, and no conflicting
 * duplicate SIDs. Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Suricata rule.', code: 'EMPTY' })
  }

  const seen = new Map<string, string>()
  items.forEach((item, i) => {
    const sid = String(item.fields.sid ?? '').trim()
    const action = String(item.fields.action ?? '')

    if (!/^[0-9]{1,12}$/.test(sid)) {
      errors.push({ field: `items[${i}].sid`, message: `SID must be numeric (got "${sid}").`, code: 'INVALID_SID' })
    } else if (seen.has(sid) && seen.get(sid) !== action) {
      warnings.push({ field: `items[${i}].sid`, message: `SID ${sid} is listed with conflicting states; the last one wins.`, code: 'CONFLICTING_SID' })
    } else if (seen.has(sid)) {
      warnings.push({ field: `items[${i}].sid`, message: `SID ${sid} is listed more than once.`, code: 'DUPLICATE_SID' })
    } else {
      seen.set(sid, action)
    }

    if (action !== 'enable' && action !== 'disable') {
      errors.push({ field: `items[${i}].action`, message: `State must be "enable" or "disable" (got "${action}").`, code: 'INVALID_ACTION' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
