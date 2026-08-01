import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { GROUP_TYPES, isValidFilterJson } from './_shared'

/**
 * Validate endpoint-group items: a non-empty name, a known group type
 * (static / dynamic), and — when a filter is provided — valid JSON. A dynamic
 * group with no filter is warned (its membership would be undefined). Static —
 * no target access required. The name doubles as identity, so a duplicate name
 * is flagged (last one wins). VERIFY the accepted group-type values against live
 * Cortex XDR.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one endpoint group.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const groupType = String(item.fields.group_type ?? '').trim().toLowerCase()
    const filter = String(item.fields.filter ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Group name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].name`, message: `Group ${name} is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    if (!GROUP_TYPES.has(groupType)) {
      errors.push({ field: `items[${i}].group_type`, message: `Group type must be one of static, dynamic (got "${groupType}").`, code: 'INVALID_GROUP_TYPE' })
    }

    if (filter && !isValidFilterJson(filter)) {
      errors.push({ field: `items[${i}].filter`, message: 'Filter must be valid JSON.', code: 'INVALID_FILTER' })
    }

    if (groupType === 'dynamic' && !filter) {
      warnings.push({ field: `items[${i}].filter`, message: `Dynamic group ${name || `#${i}`} has no filter — its membership would be undefined.`, code: 'EMPTY_DYNAMIC_FILTER' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
