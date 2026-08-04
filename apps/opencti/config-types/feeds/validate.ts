import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { toStringList } from './_shared'

/**
 * Validate feed items: required name/separator/feed_date_attribute, a positive
 * integer rolling_time, at least one entity type, well-formed `filters` JSON
 * when present, and `feed_attributes` as a JSON array of objects each with a
 * string `attribute` and an array `mappings` (shallow — OpenCTI validates the
 * full nested shape at deploy time, the same "JSON blob, shallow-validated"
 * precedent used elsewhere in this app). Static — no target access required.
 * The name doubles as the feed identity, so a duplicate is flagged (last one
 * wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one feed.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const separator = String(item.fields.separator ?? '').trim()
    const dateAttribute = String(item.fields.feed_date_attribute ?? '').trim()
    const rollingTimeRaw = item.fields.rolling_time
    const feedTypes = toStringList(item.fields.feed_types)
    const filters = String(item.fields.filters ?? '').trim()
    const feedAttributesRaw = String(item.fields.feed_attributes ?? '').trim()

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Feed name is required.', code: 'EMPTY_NAME' })
    } else if (name.length < 2) {
      errors.push({ field: `items[${i}].name`, message: 'Feed name must be at least 2 characters.', code: 'NAME_TOO_SHORT' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `Feed "${name}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }

    if (!separator) {
      errors.push({ field: `items[${i}].separator`, message: 'Separator is required.', code: 'EMPTY_SEPARATOR' })
    }

    if (!dateAttribute) {
      errors.push({ field: `items[${i}].feed_date_attribute`, message: 'Date attribute is required.', code: 'EMPTY_DATE_ATTRIBUTE' })
    }

    const rollingTime = Number(rollingTimeRaw)
    if (rollingTimeRaw === undefined || rollingTimeRaw === null || rollingTimeRaw === '' || !Number.isFinite(rollingTime) || rollingTime < 1) {
      errors.push({
        field: `items[${i}].rolling_time`,
        message: 'Rolling time is required and must be a positive number of minutes.',
        code: 'INVALID_ROLLING_TIME',
      })
    }

    if (feedTypes.length === 0) {
      errors.push({ field: `items[${i}].feed_types`, message: 'Add at least one entity type.', code: 'EMPTY_FEED_TYPES' })
    }

    if (filters) {
      try {
        JSON.parse(filters)
      } catch {
        errors.push({ field: `items[${i}].filters`, message: 'Filters must be valid JSON.', code: 'INVALID_FILTERS_JSON' })
      }
    }

    if (!feedAttributesRaw) {
      errors.push({ field: `items[${i}].feed_attributes`, message: 'Attribute mappings are required.', code: 'EMPTY_FEED_ATTRIBUTES' })
    } else {
      try {
        const parsed = JSON.parse(feedAttributesRaw)
        if (!Array.isArray(parsed)) {
          errors.push({ field: `items[${i}].feed_attributes`, message: 'Attribute mappings must be a JSON array.', code: 'INVALID_FEED_ATTRIBUTES_SHAPE' })
        } else {
          parsed.forEach((entry, ei) => {
            if (!entry || typeof entry !== 'object' || typeof entry.attribute !== 'string' || !Array.isArray(entry.mappings)) {
              errors.push({
                field: `items[${i}].feed_attributes[${ei}]`,
                message: 'Each attribute mapping needs a string "attribute" and an array "mappings".',
                code: 'INVALID_FEED_ATTRIBUTES_SHAPE',
              })
            }
          })
        }
      } catch {
        errors.push({ field: `items[${i}].feed_attributes`, message: 'Attribute mappings must be valid JSON.', code: 'INVALID_FEED_ATTRIBUTES_JSON' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
