import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate data-view items: a safe stable id, a non-empty index-pattern title
 * and display name, and — when set — a safe time-field name. Static — no
 * target access required.
 */
const ID_RE = /^[a-zA-Z0-9._-]+$/
const TITLE_RE = /^[a-zA-Z0-9*_.:,-]+$/
const FIELD_NAME_RE = /^[a-zA-Z0-9_.@-]+$/

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one data view.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const dataViewId = String(item.fields.dataViewId ?? '').trim()
    const title = String(item.fields.title ?? '').trim()
    const name = String(item.fields.name ?? '').trim()
    const timeFieldName = String(item.fields.timeFieldName ?? '').trim()

    if (!dataViewId) {
      errors.push({ field: `items[${i}].dataViewId`, message: 'Data view ID is required.', code: 'EMPTY_ID' })
    } else if (!ID_RE.test(dataViewId)) {
      errors.push({ field: `items[${i}].dataViewId`, message: `Data view ID "${dataViewId}" may only contain letters, numbers, dot, underscore or hyphen.`, code: 'INVALID_ID' })
    } else if (seen.has(dataViewId)) {
      warnings.push({ field: `items[${i}].dataViewId`, message: `Data view ${dataViewId} is listed more than once; the last one wins.`, code: 'DUPLICATE_ID' })
    } else {
      seen.add(dataViewId)
    }

    if (!title) {
      errors.push({ field: `items[${i}].title`, message: 'Index pattern (title) is required.', code: 'EMPTY_TITLE' })
    } else if (!TITLE_RE.test(title)) {
      errors.push({ field: `items[${i}].title`, message: `Index pattern "${title}" contains characters that are not valid in a Kibana data view title.`, code: 'INVALID_TITLE' })
    }

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Display name is required.', code: 'EMPTY_NAME' })
    }

    if (timeFieldName && !FIELD_NAME_RE.test(timeFieldName)) {
      errors.push({ field: `items[${i}].timeFieldName`, message: `Time field "${timeFieldName}" may only contain letters, numbers, dot, underscore, @ or hyphen.`, code: 'INVALID_TIME_FIELD' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
