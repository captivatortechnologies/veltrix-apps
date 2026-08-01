import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { TAG_ENTITIES, normalizeEntity, parseText, EXPIRATION_RE } from './_shared'

/**
 * Validate tag items: a non-empty tag name (the identity), a known asset module
 * (devices|users) and a non-empty AQL filter. The filter is REQUIRED — an empty
 * filter would tag every asset in the module, which is almost never intended, so
 * it is a hard error rather than a warning. An optional expiration must be a
 * YYYY-MM-DD date. Static: no target access. A duplicate tag within the same
 * module is flagged (idempotent, but a signal of a copy/paste mistake).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one tag.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = parseText(item.fields.name)
    const entityRaw = String(item.fields.entity ?? '').trim().toLowerCase()
    const filter = parseText(item.fields.filter)
    const expiration = parseText(item.fields.expiration)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Tag name is required.', code: 'EMPTY_NAME' })
    }

    if (!TAG_ENTITIES.includes(entityRaw as (typeof TAG_ENTITIES)[number])) {
      errors.push({
        field: `items[${i}].entity`,
        message: `Asset module must be one of ${TAG_ENTITIES.join(', ')} (got "${entityRaw}").`,
        code: 'INVALID_ENTITY',
      })
    }

    if (!filter) {
      errors.push({
        field: `items[${i}].filter`,
        message: 'An AQL filter is required — an empty filter would tag every asset in the module.',
        code: 'EMPTY_FILTER',
      })
    }

    if (expiration && !EXPIRATION_RE.test(expiration)) {
      errors.push({
        field: `items[${i}].expiration`,
        message: `Expiration must be a YYYY-MM-DD date (got "${expiration}").`,
        code: 'INVALID_EXPIRATION',
      })
    }

    if (name) {
      const key = `${normalizeEntity(entityRaw)}::${name}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Tag "${name}" is listed more than once for ${normalizeEntity(entityRaw)}; the last one wins.`,
          code: 'DUPLICATE_TAG',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
