import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { ENTITY_TYPES } from './_shared'

/**
 * Validate entity-tags items. Static — no target access required.
 *   - entity_type must be one of host / account.
 *   - entity_id is required and numeric.
 *   - the (entity_type, entity_id) PAIR is the real identity — a host 123 and an
 *     account 123 are different entities, so duplicates are checked on the pair,
 *     not entity_id alone.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one entity.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const entityType = String(item.fields.entity_type ?? '').trim()
    const entityId = String(item.fields.entity_id ?? '').trim()

    if (!entityType) {
      errors.push({ field: `items[${i}].entity_type`, message: 'Entity type is required.', code: 'EMPTY_ENTITY_TYPE' })
    } else if (!ENTITY_TYPES.has(entityType)) {
      errors.push({ field: `items[${i}].entity_type`, message: `Entity type "${entityType}" is not one of ${[...ENTITY_TYPES].join(', ')}.`, code: 'INVALID_ENTITY_TYPE' })
    }

    if (!entityId) {
      errors.push({ field: `items[${i}].entity_id`, message: 'Entity ID is required.', code: 'EMPTY_ENTITY_ID' })
    } else if (!Number.isFinite(Number(entityId))) {
      errors.push({ field: `items[${i}].entity_id`, message: `Entity ID "${entityId}" is not numeric.`, code: 'NON_NUMERIC_ENTITY_ID' })
    }

    if (entityType && entityId) {
      const key = `${entityType}:${entityId}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].entity_id`,
          message: `Entity "${entityType} ${entityId}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_ENTITY',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
