import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { asString } from '../../lib/coerce'
import { buildLookupDataAdapterBody } from './_shared'

/** Graylog lookup-table entity names must be lowercase word/dash/dot characters. */
const NAME_REGEX = /^[a-z0-9][a-z0-9_.-]*$/

/**
 * Validate lookup-data-adapter items: a non-empty title, a non-empty name
 * matching Graylog's entity-name convention (the stable identity used for
 * upsert and as the reference lookup tables point to), and a well-formed
 * `config` JSON object with a `type` discriminator (e.g. "csvfile",
 * "dnslookup", "httpjsonpath"). Static — no target access, so per-type required
 * config keys surface at deploy time.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one lookup data adapter.', code: 'EMPTY' })
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

    const { error } = buildLookupDataAdapterBody(item.fields)
    if (error) {
      errors.push({ field: `items[${i}].config`, message: error, code: 'INVALID_CONFIG' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
