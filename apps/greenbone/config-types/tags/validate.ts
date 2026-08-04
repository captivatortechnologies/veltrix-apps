import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { UUID_RE } from '../../lib/greenboneApi'

/**
 * Validate tag items: a non-empty name, a resource type, and (if any resource
 * ids are declared) each must be UUID-shaped. Static — no gvmd access
 * required. Tag names double as this app's upsert identity (gvmd itself does
 * not enforce name uniqueness for tags), so a duplicate name is flagged.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one tag.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const resourceType = String(item.fields.resourceType ?? '').trim()
    const resourceIds = Array.isArray(item.fields.resourceIds) ? item.fields.resourceIds : []

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Tag name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: `items[${i}].name`, message: `Tag name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    if (!resourceType) {
      errors.push({ field: `items[${i}].resourceType`, message: 'A resource type is required.', code: 'EMPTY_RESOURCE_TYPE' })
    }

    resourceIds.forEach((id, ri) => {
      if (!UUID_RE.test(String(id).trim())) {
        errors.push({ field: `items[${i}].resourceIds[${ri}]`, message: `"${id}" must be a resource UUID.`, code: 'INVALID_RESOURCE_ID' })
      }
    })
  })

  return { valid: errors.length === 0, errors, warnings }
}
