import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'

/**
 * Validate EdgeWorker items: a non-empty name (≤85 chars), a positive group
 * id and a positive resource tier id. Static — no target access required. The
 * name is the identity, so a duplicate is flagged.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one EdgeWorker.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const groupId = item.fields.groupId
    const resourceTierId = item.fields.resourceTierId

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    } else if (name.length > 85) {
      errors.push({ field: `items[${i}].name`, message: 'Name must be 85 characters or fewer.', code: 'NAME_TOO_LONG' })
    } else {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].name`, message: `Name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    if (typeof groupId !== 'number' || !Number.isFinite(groupId) || groupId < 1) {
      errors.push({ field: `items[${i}].groupId`, message: 'Group ID must be a positive number.', code: 'INVALID_GROUP_ID' })
    }

    if (typeof resourceTierId !== 'number' || !Number.isFinite(resourceTierId) || resourceTierId < 1) {
      errors.push({ field: `items[${i}].resourceTierId`, message: 'Resource Tier ID must be a positive number.', code: 'INVALID_RESOURCE_TIER' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
