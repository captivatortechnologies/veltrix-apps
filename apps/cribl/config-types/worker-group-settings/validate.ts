import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseSettings, CRIBL_ID_RE } from './_shared'
import { resolveWorkerGroup } from '../../lib/criblCommon'

/**
 * Validate Worker Group Settings items: a well-formed target Worker Group and
 * a `settings` value that parses to a JSON object. Static. One item per group,
 * so a second item for the same group is flagged (last wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const settingsCtx = ctx.settings ?? {}

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Worker Group Settings entry.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const group = resolveWorkerGroup(item.fields, settingsCtx)
    if (group && !CRIBL_ID_RE.test(group)) {
      errors.push({ field: `items[${i}].worker_group`, message: `Worker Group "${group}" may contain only letters, digits, underscore and hyphen.`, code: 'INVALID_GROUP' })
    } else if (seen.has(group)) {
      warnings.push({ field: `items[${i}].worker_group`, message: `Worker Group ${group || '(single-instance)'} is listed more than once; the last one wins.`, code: 'DUPLICATE_ID' })
    } else {
      seen.add(group)
    }

    const { error } = parseSettings(item.fields.settings)
    if (error) errors.push({ field: `items[${i}].settings`, message: error, code: 'INVALID_SETTINGS' })
  })

  return { valid: errors.length === 0, errors, warnings }
}
