import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseJsonField } from '../../lib/reconcile'

/**
 * Validate discovery-view items: a non-empty name (the identity) and a Discovery
 * query that parses as a JSON object. Extra params, when given, must parse as a
 * JSON object. Static — no target access required. A duplicate name is flagged.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one discovery view.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Discovery view name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Discovery view name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    const query = parseJsonField(item.fields.query, 'Discovery query')
    if (!query.ok) {
      errors.push({ field: `items[${i}].query`, message: query.error, code: 'INVALID_QUERY' })
    } else if (!query.value || typeof query.value !== 'object' || Array.isArray(query.value)) {
      errors.push({ field: `items[${i}].query`, message: 'Discovery query must be a JSON object.', code: 'INVALID_QUERY' })
    }

    // extra params are optional; only validated when provided.
    const rawExtra = typeof item.fields.extraParams === 'string' ? item.fields.extraParams.trim() : ''
    if (rawExtra) {
      const extra = parseJsonField(item.fields.extraParams, 'Extra params')
      if (!extra.ok) {
        errors.push({ field: `items[${i}].extraParams`, message: extra.error, code: 'INVALID_EXTRA_PARAMS' })
      } else if (!extra.value || typeof extra.value !== 'object' || Array.isArray(extra.value)) {
        errors.push({ field: `items[${i}].extraParams`, message: 'Extra params must be a JSON object.', code: 'INVALID_EXTRA_PARAMS' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
