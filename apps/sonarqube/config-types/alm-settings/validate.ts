import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { ALM_TYPES, REQUIRED_ON_CREATE, FIELD_LABELS } from './_shared'

/**
 * Validate ALM-setting items: a non-empty `key` (the upsert identity — SonarQube setting
 * keys are globally unique, so a duplicate is a hard conflict, not a "last one wins"
 * situation) and a recognized `almType`. Fields SonarQube requires on create_<almType> are
 * only WARNED on when blank — this app cannot know at validate time whether `key` already
 * exists in SonarQube, so a blank secret may simply mean "leave the existing value
 * unchanged" on an update. Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one ALM setting.', code: 'EMPTY' })
  }

  const seenKeys = new Set<string>()

  items.forEach((item, i) => {
    const key = String(item.fields.key ?? '').trim()
    const almType = String(item.fields.almType ?? '').trim()

    if (!key) {
      errors.push({ field: `items[${i}].key`, message: 'ALM setting key is required.', code: 'EMPTY_KEY' })
    } else if (seenKeys.has(key)) {
      errors.push({
        field: `items[${i}].key`,
        message: `ALM setting key "${key}" is listed more than once. SonarQube setting keys must be globally unique — create_${almType || '<almType>'} would simply fail on the second one, so this is an error rather than a warning.`,
        code: 'DUPLICATE_KEY',
      })
    } else {
      seenKeys.add(key)
    }

    if (!almType) {
      errors.push({ field: `items[${i}].almType`, message: 'ALM type is required.', code: 'EMPTY_ALM_TYPE' })
      return
    }
    if (!ALM_TYPES.has(almType)) {
      errors.push({
        field: `items[${i}].almType`,
        message: `ALM type "${almType}" is not one of: ${[...ALM_TYPES].join(', ')}.`,
        code: 'INVALID_ALM_TYPE',
      })
      return
    }

    for (const fieldKey of REQUIRED_ON_CREATE[almType] ?? []) {
      const value = String((item.fields as Record<string, unknown>)[fieldKey] ?? '').trim()
      if (value) continue
      warnings.push({
        field: `items[${i}].${fieldKey}`,
        message: `${FIELD_LABELS[fieldKey] ?? fieldKey} is blank. This is required only if key "${key || '(blank)'}" does not already exist in SonarQube — if it does, this deploy will leave the current stored value unchanged; if it's a brand new key, create_${almType} will fail without it.`,
        code: 'MISSING_ON_CREATE',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
