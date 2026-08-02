import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { PIPELINE_ID_RE, parseConf } from './_shared'

/**
 * Validate pipeline items: a non-empty, well-formed id and a `conf` that parses
 * to JSON containing a `functions` array. Static — no target access required. The
 * pipeline id is the stable identity, so a duplicate id is flagged (last wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one pipeline.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const id = String(item.fields.id ?? '').trim()

    if (!id) {
      errors.push({ field: `items[${i}].id`, message: 'Pipeline ID is required.', code: 'EMPTY_ID' })
    } else if (!PIPELINE_ID_RE.test(id)) {
      errors.push({
        field: `items[${i}].id`,
        message: `Pipeline ID "${id}" may contain only letters, digits, underscore and hyphen.`,
        code: 'INVALID_ID',
      })
    } else if (seen.has(id)) {
      warnings.push({ field: `items[${i}].id`, message: `Pipeline ID ${id} is listed more than once; the last one wins.`, code: 'DUPLICATE_ID' })
    } else {
      seen.add(id)
    }

    const { conf, error } = parseConf(item.fields.conf)
    if (error) {
      errors.push({ field: `items[${i}].conf`, message: error, code: 'INVALID_CONF' })
    } else if (conf && conf.functions.length === 0) {
      warnings.push({ field: `items[${i}].conf`, message: `Pipeline ${id || i} has no Functions — it will pass events through unchanged.`, code: 'EMPTY_FUNCTIONS' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
