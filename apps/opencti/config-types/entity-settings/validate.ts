import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate entity-setting items: a non-empty `target_type`, and — when present
 * — well-formed JSON for `attributes_configuration` (any JSON value) and
 * `overview_layout_customization` (must be a JSON array). Static — no target
 * access required; whether `target_type` actually exists on the OpenCTI
 * instance is checked at deploy time (network-dependent). The target_type
 * doubles as this item's identity, so a duplicate is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one entity setting.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const targetType = String(item.fields.target_type ?? '').trim()
    const attributesConfiguration = String(item.fields.attributes_configuration ?? '').trim()
    const overviewLayout = String(item.fields.overview_layout_customization ?? '').trim()

    if (!targetType) {
      errors.push({ field: `items[${i}].target_type`, message: 'Target type is required.', code: 'EMPTY_TARGET_TYPE' })
    } else {
      const key = targetType.toLowerCase()
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].target_type`,
          message: `Target type "${targetType}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_TARGET_TYPE',
        })
      } else {
        seen.add(key)
      }
    }

    if (attributesConfiguration) {
      try {
        JSON.parse(attributesConfiguration)
      } catch {
        errors.push({
          field: `items[${i}].attributes_configuration`,
          message: 'Attributes configuration must be valid JSON.',
          code: 'INVALID_ATTRIBUTES_CONFIGURATION_JSON',
        })
      }
    }

    if (overviewLayout) {
      try {
        const parsed = JSON.parse(overviewLayout)
        if (!Array.isArray(parsed)) {
          errors.push({
            field: `items[${i}].overview_layout_customization`,
            message: 'Overview layout customization must be a JSON array.',
            code: 'INVALID_OVERVIEW_LAYOUT_SHAPE',
          })
        }
      } catch {
        errors.push({
          field: `items[${i}].overview_layout_customization`,
          message: 'Overview layout customization must be valid JSON.',
          code: 'INVALID_OVERVIEW_LAYOUT_JSON',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
