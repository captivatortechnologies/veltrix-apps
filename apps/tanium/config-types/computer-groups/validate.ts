import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseFilterJson, groupModeOf, computerSpecsOf } from './_shared'

/**
 * Validate computer-group items: a non-empty name and, depending on `mode`,
 * either a membership filter (filter mode — a filter expression OR a structured
 * filter JSON, which must parse) or an explicit host/IP list (manual mode —
 * `computerNames` and/or `ipAddresses`). Static — no target access required. The
 * name doubles as the group identity, so a duplicate name is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one computer group.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Computer group name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name.toLowerCase())) {
      warnings.push({ field: `items[${i}].name`, message: `Computer group name ${name} is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name.toLowerCase())
    }

    if (groupModeOf(item.fields) === 'manual') {
      if (computerSpecsOf(item.fields).length === 0) {
        errors.push({
          field: `items[${i}].computerNames`,
          message: 'Provide at least one computer name or IP address so the manual group has members.',
          code: 'NO_MEMBERS',
        })
      }
      return
    }

    const filterText = String(item.fields.filterText ?? '').trim()
    const filterJsonRaw = String(item.fields.filterJson ?? '').trim()

    if (!filterText && !filterJsonRaw) {
      errors.push({
        field: `items[${i}].filterText`,
        message: 'Provide a filter expression or a structured filter JSON so the group can select endpoints.',
        code: 'NO_FILTER',
      })
    }

    if (filterJsonRaw) {
      const parsed = parseFilterJson(filterJsonRaw)
      if (parsed.error) {
        errors.push({ field: `items[${i}].filterJson`, message: parsed.error, code: 'INVALID_FILTER_JSON' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
