import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseText, parseJsonObject, parseJsonArray } from './_shared'

/**
 * Validate enforcement-set items: a non-empty name (the upsert identity), a
 * non-empty action name (the Axonius action-library identifier of the main
 * action), a config that parses to a JSON object, and — when supplied — triggers
 * that parse to a JSON array. Static: no target access. A duplicate name is
 * flagged (last one wins). The action_name and config internals are tenant/version
 * specific, so they are shape-checked here but not validated against the live
 * action library.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one enforcement set.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = parseText(item.fields.name)
    const actionName = parseText(item.fields.action_name)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Enforcement set name is required.', code: 'EMPTY_NAME' })
    }

    if (!actionName) {
      errors.push({
        field: `items[${i}].action_name`,
        message: 'Main action name is required (the Axonius action-library identifier, e.g. "create_notification").',
        code: 'EMPTY_ACTION_NAME',
      })
    }

    const config = parseJsonObject(item.fields.config)
    if (!config.ok) {
      errors.push({
        field: `items[${i}].config`,
        message: `Action config is not a valid JSON object: ${config.error}`,
        code: 'INVALID_CONFIG',
      })
    }

    const triggers = parseJsonArray(item.fields.triggers)
    if (!triggers.ok) {
      errors.push({
        field: `items[${i}].triggers`,
        message: `Triggers must be a JSON array: ${triggers.error}`,
        code: 'INVALID_TRIGGERS',
      })
    } else if (triggers.value.length === 0) {
      warnings.push({
        field: `items[${i}].triggers`,
        message: `Enforcement set "${name || i}" has no trigger — it will only run on demand, never on a schedule.`,
        code: 'NO_TRIGGER',
      })
    }

    if (name) {
      if (seen.has(name)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Enforcement set "${name}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(name)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
