import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { asString, toInt } from '../../lib/coerce'
import {
  INDEX_PREFIX_REGEX,
  ISO8601_PERIOD_REGEX,
  ROTATION_STRATEGIES,
  RETENTION_STRATEGIES,
} from './_shared'

/**
 * Validate index-set items: a non-empty title (the identity — a duplicate is
 * flagged, last one wins), a valid lowercase index_prefix, a known rotation and
 * retention strategy, and strategy parameters appropriate to the chosen kind
 * (a positive doc/size/index count, or an ISO-8601 period for time rotation).
 * Static — no target access.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one index set.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const title = asString(item.fields.title)
    const indexPrefix = asString(item.fields.index_prefix)
    const rotation = asString(item.fields.rotation_strategy).toLowerCase() || 'msgcount'
    const retention = asString(item.fields.retention_strategy).toLowerCase() || 'delete'

    if (!title) {
      errors.push({ field: `items[${i}].title`, message: 'Index set title is required.', code: 'EMPTY_TITLE' })
    } else if (seen.has(title)) {
      warnings.push({ field: `items[${i}].title`, message: `Index set title "${title}" is listed more than once; the last one wins.`, code: 'DUPLICATE_TITLE' })
    } else {
      seen.add(title)
    }

    if (!indexPrefix) {
      errors.push({ field: `items[${i}].index_prefix`, message: 'Index prefix is required.', code: 'EMPTY_INDEX_PREFIX' })
    } else if (!INDEX_PREFIX_REGEX.test(indexPrefix)) {
      errors.push({ field: `items[${i}].index_prefix`, message: `Index prefix "${indexPrefix}" must be lowercase and match ${INDEX_PREFIX_REGEX} (start with a letter/digit; letters, digits, _, +, - only).`, code: 'INVALID_INDEX_PREFIX' })
    }

    if (!(rotation in ROTATION_STRATEGIES)) {
      errors.push({ field: `items[${i}].rotation_strategy`, message: `Rotation strategy must be one of ${Object.keys(ROTATION_STRATEGIES).join(', ')} (got "${rotation}").`, code: 'INVALID_ROTATION_STRATEGY' })
    } else {
      const raw = item.fields.rotation_value
      if (rotation === 'time') {
        const period = asString(raw)
        if (!period || !ISO8601_PERIOD_REGEX.test(period)) {
          errors.push({ field: `items[${i}].rotation_value`, message: `Time rotation needs an ISO-8601 period (e.g. P1D, PT6H); got "${period}".`, code: 'INVALID_ROTATION_PERIOD' })
        }
      } else if (toInt(raw, 0) < 1) {
        const what = rotation === 'size' ? 'a max index size in bytes' : 'a max document count'
        errors.push({ field: `items[${i}].rotation_value`, message: `${rotation === 'size' ? 'Size' : 'Message-count'} rotation needs ${what} of 1 or more.`, code: 'INVALID_ROTATION_VALUE' })
      }
    }

    if (!(retention in RETENTION_STRATEGIES)) {
      errors.push({ field: `items[${i}].retention_strategy`, message: `Retention strategy must be one of ${Object.keys(RETENTION_STRATEGIES).join(', ')} (got "${retention}").`, code: 'INVALID_RETENTION_STRATEGY' })
    } else if (retention !== 'none' && toInt(item.fields.retention_max_indices, 0) < 1) {
      errors.push({ field: `items[${i}].retention_max_indices`, message: 'Retention needs a max number of indices of 1 or more.', code: 'INVALID_RETENTION_VALUE' })
    }

    if (item.fields.shards !== undefined && item.fields.shards !== '' && toInt(item.fields.shards, 0) < 1) {
      errors.push({ field: `items[${i}].shards`, message: 'Shards must be 1 or more.', code: 'INVALID_SHARDS' })
    }
    if (item.fields.replicas !== undefined && item.fields.replicas !== '' && toInt(item.fields.replicas, -1) < 0) {
      errors.push({ field: `items[${i}].replicas`, message: 'Replicas must be 0 or more.', code: 'INVALID_REPLICAS' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
