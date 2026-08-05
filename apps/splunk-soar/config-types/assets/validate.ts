import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { buildAssetSpec } from './_shared'

/**
 * Validate asset items: a non-empty name, and both product_vendor and
 * product_name (the identification path this type supports — see README
 * Coverage for the app_id/app_guid alternative this type does not model).
 * Static — no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one asset.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const spec = buildAssetSpec(item.fields)
    if (!spec.id) {
      errors.push({ field: `items[${i}].name`, message: 'Asset name is required.', code: 'EMPTY_NAME' })
      return
    }
    if (spec.error) {
      errors.push({ field: `items[${i}]`, message: spec.error, code: 'INVALID' })
      return
    }
    const key = spec.id.toLowerCase()
    if (seen.has(key)) {
      warnings.push({ field: `items[${i}].name`, message: `Asset name "${spec.id}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(key)
    }
    if (Object.keys(spec.configuration).length === 0) {
      warnings.push({
        field: `items[${i}].configuration`,
        message: 'No additional configuration set — most SOAR apps require at least some asset configuration to function.',
        code: 'EMPTY_CONFIGURATION',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
