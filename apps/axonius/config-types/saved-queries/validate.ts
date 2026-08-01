import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { SAVED_QUERY_ENTITIES, normalizeEntity, parseFields } from './_shared'

/**
 * Validate saved-query items: a non-empty name, a known asset module
 * (devices|users) and, per column, a non-empty field name. Static — no target
 * access required. The name doubles as the saved-query identity, so a duplicate
 * name within the same module is flagged (last one wins). An empty AQL filter is
 * allowed (matches every asset) but warned so it is a deliberate choice.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one saved query.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const entityRaw = String(item.fields.entity ?? '').trim().toLowerCase()
    const filter = String(item.fields.query ?? '').trim()
    const columns = parseFields(item.fields.fields)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Saved query name is required.', code: 'EMPTY_NAME' })
    }

    if (!SAVED_QUERY_ENTITIES.includes(entityRaw as (typeof SAVED_QUERY_ENTITIES)[number])) {
      errors.push({
        field: `items[${i}].entity`,
        message: `Asset module must be one of ${SAVED_QUERY_ENTITIES.join(', ')} (got "${entityRaw}").`,
        code: 'INVALID_ENTITY',
      })
    }

    // Name identity is scoped to the module — a devices and a users query may
    // share a name without colliding.
    if (name) {
      const key = `${normalizeEntity(entityRaw)}::${name}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Saved query "${name}" is listed more than once for ${normalizeEntity(entityRaw)}; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }

    if (!filter) {
      warnings.push({
        field: `items[${i}].query`,
        message: `Saved query "${name || i}" has an empty AQL filter — it will match every ${normalizeEntity(entityRaw)} asset.`,
        code: 'EMPTY_FILTER',
      })
    }

    columns.forEach((col, c) => {
      if (!col.trim()) {
        errors.push({ field: `items[${i}].fields[${c}]`, message: 'Column field names must be non-empty.', code: 'EMPTY_FIELD' })
      }
    })
  })

  return { valid: errors.length === 0, errors, warnings }
}
