import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { TRIGGER_EVENT_TYPES, toStringList } from './_shared'

/**
 * Validate notification-trigger items: a non-empty name (>= 2 chars), at least
 * one known TriggerEventType, and — when present — well-formed `filters` JSON.
 * Static — no target access required. The name doubles as the trigger
 * identity, so a duplicate is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one notification trigger.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const eventTypes = toStringList(item.fields.event_types)
    const filters = String(item.fields.filters ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Trigger name is required.', code: 'EMPTY_NAME' })
    } else if (name.length < 2) {
      errors.push({ field: `items[${i}].name`, message: 'Trigger name must be at least 2 characters.', code: 'NAME_TOO_SHORT' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Trigger "${name}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }

    if (eventTypes.length === 0) {
      errors.push({ field: `items[${i}].event_types`, message: 'Select at least one event type.', code: 'EMPTY_EVENT_TYPES' })
    } else {
      const invalid = eventTypes.filter((t) => !TRIGGER_EVENT_TYPES.has(t))
      if (invalid.length > 0) {
        errors.push({
          field: `items[${i}].event_types`,
          message: `Event type(s) ${invalid.join(', ')} must be one of create, update, delete.`,
          code: 'INVALID_EVENT_TYPE',
        })
      }
    }

    if (filters) {
      try {
        JSON.parse(filters)
      } catch {
        errors.push({ field: `items[${i}].filters`, message: 'Filters must be valid JSON.', code: 'INVALID_FILTERS_JSON' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
