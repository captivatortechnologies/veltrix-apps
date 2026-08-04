import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { ACTION_TYPE_BY_KEY, POLICY_TYPES, splitList, splitNumericList } from './_shared'

/**
 * Validate managed-policy items: a non-empty unique name+type pair, a known
 * type, valid response-action keys and numeric notification channel ids.
 * Static — no target access required; this app cannot confirm a managed
 * policy by this name actually exists until deploy.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one managed policy.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const type = String(item.fields.type ?? 'falco').trim()
    const p = (field: string) => `items[${i}].${field}`
    const key = `${name}::${type}`

    if (!name) {
      errors.push({ field: p('name'), message: 'Policy name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(key)) {
      warnings.push({ field: p('name'), message: `"${name}" (${type}) is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(key)
    }

    if (!POLICY_TYPES.has(type)) {
      errors.push({ field: p('type'), message: `Type must be one of ${[...POLICY_TYPES].join(', ')} (got "${type}").`, code: 'INVALID_TYPE' })
    }

    for (const key of splitList(item.fields.actions)) {
      if (!ACTION_TYPE_BY_KEY[key.toLowerCase()]) {
        errors.push({ field: p('actions'), message: `Unknown response action "${key}".`, code: 'INVALID_ACTION' })
      }
    }

    const rawChannelIds = splitList(item.fields.notificationChannelIds)
    if (rawChannelIds.length !== splitNumericList(item.fields.notificationChannelIds).length) {
      errors.push({ field: p('notificationChannelIds'), message: 'Notification Channel IDs must all be numeric.', code: 'INVALID_CHANNEL_ID' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
