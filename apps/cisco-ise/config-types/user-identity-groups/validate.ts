import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { MAX_NAME_LENGTH, MAX_DESCRIPTION_LENGTH, specFromItem } from './_shared'

/**
 * Validate identity group items: a non-empty, uniquely-named group within
 * ERS's length limits. A `parent` naming another item IN THIS SAME
 * configuration is allowed (deploy applies items in canvas order, so an
 * earlier item can be a later item's parent) — parent resolution itself is
 * live-only and happens in deploy.ts / driftDetect.ts.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one identity group.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  const names = new Set(items.map((item) => specFromItem(item).name.toLowerCase()).filter(Boolean))
  items.forEach((item, i) => {
    const spec = specFromItem(item)

    if (!spec.name) {
      errors.push({ field: `items[${i}].name`, message: 'Group name is required.', code: 'EMPTY_NAME' })
    } else if (spec.name.length > MAX_NAME_LENGTH) {
      errors.push({
        field: `items[${i}].name`,
        message: `Group name must be ${MAX_NAME_LENGTH} characters or fewer (got ${spec.name.length}).`,
        code: 'NAME_TOO_LONG',
      })
    } else {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].name`, message: `Group name "${spec.name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    if (spec.parentName && spec.parentName.toLowerCase() === spec.name.toLowerCase()) {
      errors.push({ field: `items[${i}].parent`, message: 'A group cannot be its own parent.', code: 'SELF_PARENT' })
    }
    if (spec.parentName && !names.has(spec.parentName.toLowerCase())) {
      warnings.push({
        field: `items[${i}].parent`,
        message: `Parent group "${spec.parentName}" is not declared in this configuration — it must already exist in ISE, or deploy will fail.`,
        code: 'PARENT_NOT_IN_CONFIG',
      })
    }

    if (spec.description.length > MAX_DESCRIPTION_LENGTH) {
      errors.push({
        field: `items[${i}].description`,
        message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer (got ${spec.description.length}).`,
        code: 'DESCRIPTION_TOO_LONG',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
