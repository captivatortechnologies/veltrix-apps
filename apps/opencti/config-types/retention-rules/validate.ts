import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

const RETENTION_SCOPES = new Set(['knowledge', 'file', 'workbench', 'history', 'activity'])
const RETENTION_UNITS = new Set(['minutes', 'hours', 'days'])

/**
 * Validate retention rule items: a non-empty name, a scope from the enum, a
 * max_retention of at least 1, an optional retention_unit from the enum, and an
 * optional filters string that must be valid JSON when present. Static — no
 * target access required. The name doubles as the rule identity, so a
 * duplicate is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one retention rule.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Retention rule name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Retention rule "${name}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }

    const scope = String(item.fields.scope ?? '').trim()
    if (!scope) {
      errors.push({ field: `items[${i}].scope`, message: 'Scope is required.', code: 'EMPTY_SCOPE' })
    } else if (!RETENTION_SCOPES.has(scope)) {
      errors.push({
        field: `items[${i}].scope`,
        message: `Scope "${scope}" is not a valid retention scope (knowledge, file, workbench, history, activity).`,
        code: 'INVALID_SCOPE',
      })
    }

    const maxRetentionRaw = item.fields.max_retention
    const maxRetention = Number(maxRetentionRaw)
    if (maxRetentionRaw === undefined || maxRetentionRaw === null || maxRetentionRaw === '' || !Number.isFinite(maxRetention)) {
      errors.push({ field: `items[${i}].max_retention`, message: 'Max retention is required.', code: 'EMPTY_MAX_RETENTION' })
    } else if (maxRetention < 1) {
      errors.push({
        field: `items[${i}].max_retention`,
        message: 'Max retention must be at least 1.',
        code: 'INVALID_MAX_RETENTION',
      })
    }

    const retentionUnit = String(item.fields.retention_unit ?? '').trim()
    if (retentionUnit && !RETENTION_UNITS.has(retentionUnit)) {
      errors.push({
        field: `items[${i}].retention_unit`,
        message: `Retention unit "${retentionUnit}" is not valid (minutes, hours, days).`,
        code: 'INVALID_RETENTION_UNIT',
      })
    }

    const filters = String(item.fields.filters ?? '').trim()
    if (filters) {
      try {
        JSON.parse(filters)
      } catch {
        errors.push({
          field: `items[${i}].filters`,
          message: 'Filters must be a valid JSON-encoded OpenCTI FilterGroup string.',
          code: 'INVALID_FILTERS_JSON',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
