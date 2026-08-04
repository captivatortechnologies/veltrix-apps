import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { asString } from '../../lib/coerce'
import { DEFAULT_VALUE_TYPES } from './_shared'

/** Graylog lookup-table entity names must be lowercase word/dash/dot characters. */
const NAME_REGEX = /^[a-z0-9][a-z0-9_.-]*$/

/**
 * Validate lookup-table items: a non-empty title, a non-empty name matching
 * Graylog's entity-name convention (the stable identity used for upsert), a
 * non-empty cache_name and data_adapter_name (resolved to ids at deploy time —
 * see the "Lookup Caches" and "Lookup Data Adapters" configuration types), and
 * valid default-value-type tokens when a default value is set. Static — no
 * target access, so an unresolvable cache/adapter name surfaces as a
 * deploy-time error.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one lookup table.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = asString(item.fields.name)
    const title = asString(item.fields.title)

    if (!title) {
      errors.push({ field: `items[${i}].title`, message: 'Title is required.', code: 'EMPTY_TITLE' })
    }
    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    } else if (!NAME_REGEX.test(name)) {
      errors.push({ field: `items[${i}].name`, message: `Name "${name}" must be lowercase letters, digits, dots, underscores or hyphens, starting with a letter or digit.`, code: 'INVALID_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!asString(item.fields.cache_name)) {
      errors.push({ field: `items[${i}].cache_name`, message: 'Cache name is required.', code: 'EMPTY_CACHE_NAME' })
    }
    if (!asString(item.fields.data_adapter_name)) {
      errors.push({ field: `items[${i}].data_adapter_name`, message: 'Data adapter name is required.', code: 'EMPTY_DATA_ADAPTER_NAME' })
    }

    const singleType = asString(item.fields.default_single_value_type || 'NULL').toUpperCase()
    if (!DEFAULT_VALUE_TYPES.has(singleType)) {
      errors.push({ field: `items[${i}].default_single_value_type`, message: `Must be one of ${[...DEFAULT_VALUE_TYPES].join(', ')} (got "${singleType}").`, code: 'INVALID_SINGLE_VALUE_TYPE' })
    }
    const multiType = asString(item.fields.default_multi_value_type || 'NULL').toUpperCase()
    if (!DEFAULT_VALUE_TYPES.has(multiType)) {
      errors.push({ field: `items[${i}].default_multi_value_type`, message: `Must be one of ${[...DEFAULT_VALUE_TYPES].join(', ')} (got "${multiType}").`, code: 'INVALID_MULTI_VALUE_TYPE' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
