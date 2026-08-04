import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { asString, parseJsonObject } from '../../lib/coerce'

/**
 * Validate output items: a non-empty title (the identity — a duplicate is
 * flagged, last one wins), a non-empty type (the fully-qualified Graylog
 * output class, e.g. org.graylog2.outputs.GelfOutput), and well-formed
 * configuration JSON. Static — no target access, so per-type required
 * configuration keys surface at deploy time.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one output.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const title = asString(item.fields.title)
    const type = asString(item.fields.type)

    if (!title) {
      errors.push({ field: `items[${i}].title`, message: 'Output title is required.', code: 'EMPTY_TITLE' })
    } else if (seen.has(title)) {
      warnings.push({ field: `items[${i}].title`, message: `Output title "${title}" is listed more than once; the last one wins.`, code: 'DUPLICATE_TITLE' })
    } else {
      seen.add(title)
    }

    if (!type) {
      errors.push({ field: `items[${i}].type`, message: 'Output type is required (the fully-qualified Graylog output class).', code: 'EMPTY_TYPE' })
    } else if (!type.includes('.')) {
      warnings.push({ field: `items[${i}].type`, message: `Output type "${type}" is not a fully-qualified class (expected e.g. org.graylog2.outputs.GelfOutput).`, code: 'SUSPICIOUS_TYPE' })
    }

    const { error } = parseJsonObject(item.fields.configuration)
    if (error) {
      errors.push({ field: `items[${i}].configuration`, message: `configuration ${error}`, code: 'INVALID_CONFIG_JSON' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
