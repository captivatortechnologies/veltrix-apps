import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { tryParseJsonArray } from './_shared'

const MONITOR_TYPES = new Set(['Logs', 'Metrics', 'Slo'])

/**
 * Validate monitor items: a non-empty name, a valid monitor type, and
 * well-formed JSON for queries/triggers/notifications. Static — no target
 * access required. Monitor names are only unique within a parent folder in
 * Sumo Logic, so a duplicate (name, parentId) pair is flagged rather than a
 * bare duplicate name.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one monitor.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const parentId = String(item.fields.parentId ?? '').trim()
    const monitorType = String(item.fields.monitorType ?? '').trim() || 'Logs'

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Monitor name is required.', code: 'EMPTY_NAME' })
    } else {
      const key = `${parentId.toLowerCase()}::${name.toLowerCase()}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Monitor "${name}" is listed more than once for the same parent folder; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }

    if (!MONITOR_TYPES.has(monitorType)) {
      errors.push({ field: `items[${i}].monitorType`, message: 'Monitor type must be Logs, Metrics or Slo.', code: 'INVALID_MONITOR_TYPE' })
    }

    const queries = tryParseJsonArray(item.fields.queries, 'Queries')
    if (queries === null) {
      errors.push({ field: `items[${i}].queries`, message: 'Queries must be a well-formed JSON array.', code: 'INVALID_QUERIES_JSON' })
    } else if (queries.length === 0) {
      errors.push({ field: `items[${i}].queries`, message: 'At least one query is required.', code: 'EMPTY_QUERIES' })
    } else if (queries.some((q) => !q || typeof q !== 'object' || !(q as Record<string, unknown>).query)) {
      errors.push({ field: `items[${i}].queries`, message: 'Each query must be an object with a non-empty "query" string.', code: 'INVALID_QUERY_SHAPE' })
    }

    const triggers = tryParseJsonArray(item.fields.triggers, 'Triggers')
    if (triggers === null) {
      errors.push({ field: `items[${i}].triggers`, message: 'Trigger conditions must be a well-formed JSON array.', code: 'INVALID_TRIGGERS_JSON' })
    } else if (triggers.length === 0) {
      errors.push({ field: `items[${i}].triggers`, message: 'At least one trigger condition is required.', code: 'EMPTY_TRIGGERS' })
    } else if (triggers.some((t) => !t || typeof t !== 'object' || !(t as Record<string, unknown>).triggerType)) {
      errors.push({ field: `items[${i}].triggers`, message: 'Each trigger condition must be an object with a "triggerType".', code: 'INVALID_TRIGGER_SHAPE' })
    }

    const notifications = tryParseJsonArray(item.fields.notifications, 'Notifications')
    if (notifications === null) {
      errors.push({ field: `items[${i}].notifications`, message: 'Notifications must be a well-formed JSON array.', code: 'INVALID_NOTIFICATIONS_JSON' })
    } else if (notifications.length === 0) {
      warnings.push({
        field: `items[${i}].notifications`,
        message: `Monitor "${name || i}" has no notifications configured — it will track state silently.`,
        code: 'NO_NOTIFICATIONS',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
