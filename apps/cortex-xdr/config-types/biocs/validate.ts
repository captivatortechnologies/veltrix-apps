import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { BIOC_TYPES, BIOC_SEVERITIES, BIOC_STATUSES, isValidJson } from './_shared'

/**
 * Validate BIOC items: a non-empty name, a known type + severity + status, and —
 * when provided — valid JSON for the indicator (behavioral-match criteria).
 * Static — no target access required. The name doubles as the rule's identity,
 * so a duplicate is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one BIOC rule.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const type = String(item.fields.type ?? '').trim()
    const severity = String(item.fields.severity ?? '').trim()
    const status = String(item.fields.status ?? '').trim().toLowerCase() || 'enabled'

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Rule name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].name`, message: `Rule "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    if (!BIOC_TYPES.has(type)) {
      errors.push({ field: `items[${i}].type`, message: `Type must be one of ${[...BIOC_TYPES].join(', ')} (got "${type}").`, code: 'INVALID_TYPE' })
    }

    if (!BIOC_SEVERITIES.has(severity)) {
      errors.push({ field: `items[${i}].severity`, message: `Severity must be one of ${[...BIOC_SEVERITIES].join(', ')} (got "${severity}").`, code: 'INVALID_SEVERITY' })
    }

    if (!BIOC_STATUSES.has(status)) {
      errors.push({ field: `items[${i}].status`, message: `Status must be one of ${[...BIOC_STATUSES].join(', ')} (got "${status}").`, code: 'INVALID_STATUS' })
    }

    if (!isValidJson(item.fields.indicator)) {
      errors.push({ field: `items[${i}].indicator`, message: 'Indicator must be blank or a valid JSON object.', code: 'INVALID_INDICATOR_JSON' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
