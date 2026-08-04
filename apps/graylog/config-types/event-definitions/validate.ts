import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { asString, toInt } from '../../lib/coerce'
import { buildEventDefinitionEntity, EVENT_PRIORITIES } from './_shared'

/**
 * Validate event-definition items: a non-empty title (the identity — a
 * duplicate is flagged, last one wins), a valid priority (0-4), and
 * well-formed JSON for config / field_spec / key_spec / notification_settings
 * / notifications / storage / tags (all parsed and cross-checked by
 * buildEventDefinitionEntity). Static — no target access, so per-processor
 * required config keys and referenced notification ids surface at deploy time.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one event definition.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const title = asString(item.fields.title)

    if (!title) {
      errors.push({ field: `items[${i}].title`, message: 'Event definition title is required.', code: 'EMPTY_TITLE' })
    } else if (seen.has(title)) {
      warnings.push({ field: `items[${i}].title`, message: `Title "${title}" is listed more than once; the last one wins.`, code: 'DUPLICATE_TITLE' })
    } else {
      seen.add(title)
    }

    const priority = toInt(item.fields.priority, 2)
    if (!(priority in EVENT_PRIORITIES)) {
      errors.push({ field: `items[${i}].priority`, message: `Priority must be one of ${Object.keys(EVENT_PRIORITIES).join(', ')} (got "${priority}").`, code: 'INVALID_PRIORITY' })
    }

    const { entity, error } = buildEventDefinitionEntity(item.fields)
    if (error) {
      errors.push({ field: `items[${i}]`, message: error, code: 'INVALID_CONFIG' })
    } else if (entity && entity.notifications.length === 0) {
      warnings.push({ field: `items[${i}].notifications`, message: 'No notifications attached — this event definition will fire silently (visible only in the Alerts view).', code: 'NO_NOTIFICATIONS' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
