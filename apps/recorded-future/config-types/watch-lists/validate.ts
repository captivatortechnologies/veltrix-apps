import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { LIST_TYPES, parseEntities } from './_shared'

/**
 * Validate Watch List items: a non-empty name, a known list type, and — when
 * provided — well-formed entity lines. Static — no target access required. The
 * list NAME doubles as the list identity, so a duplicate name is flagged (last
 * one wins). A list with no entities is allowed (an empty list can be created and
 * populated later) but warned about.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Watch List.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const listType = String(item.fields.listType ?? '').trim()
    const entities = parseEntities(item.fields.entities)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Watch List name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].name`, message: `Watch List "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    if (!LIST_TYPES.has(listType)) {
      errors.push({
        field: `items[${i}].listType`,
        message: `Type must be one of ${[...LIST_TYPES].join(', ')} (got "${listType}").`,
        code: 'INVALID_TYPE',
      })
    }

    if (entities.length === 0) {
      warnings.push({
        field: `items[${i}].entities`,
        message: `Watch List "${name || i}" has no entities — an empty list will be created.`,
        code: 'NO_ENTITIES',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
