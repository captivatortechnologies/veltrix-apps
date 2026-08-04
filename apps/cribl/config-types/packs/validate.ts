import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { buildPackSpec, groupOf } from './_shared'

/**
 * Validate Pack items: a well-formed id and a non-empty `source` (git URL or
 * registry reference). Static. The pack id is the stable identity, scoped per
 * Worker Group, so a duplicate id within the same group is flagged (last wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const settings = ctx.settings ?? {}

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Pack.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const spec = buildPackSpec(item.fields)
    if (!spec.id) {
      errors.push({ field: `items[${i}].id`, message: 'Pack ID is required.', code: 'EMPTY_ID' })
      return
    }
    if (spec.error) {
      errors.push({ field: `items[${i}]`, message: spec.error, code: 'INVALID' })
      return
    }
    const group = groupOf(item.fields, settings)
    const scopedId = `${group}/${spec.id}`
    if (seen.has(scopedId)) {
      warnings.push({
        field: `items[${i}].id`,
        message: `Pack ID ${spec.id} is listed more than once for group ${group || '(single-instance)'}; the last one wins.`,
        code: 'DUPLICATE_ID',
      })
    } else {
      seen.add(scopedId)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
