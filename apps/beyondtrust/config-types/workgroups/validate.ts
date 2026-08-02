import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { WORKGROUP_NAME_MAX, isGuid, str, workgroupIdentity } from './_shared'

/**
 * Validate workgroup items: a non-empty name within Password Safe's length
 * limit, and — when provided — a well-formed organization GUID. Static — no
 * target access required. The name is the identity, so a duplicate is flagged
 * (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one workgroup.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const name = str(item.fields.name)
    const organizationId = str(item.fields.organizationId)

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Workgroup name is required.', code: 'EMPTY_NAME' })
    } else if (name.length > WORKGROUP_NAME_MAX) {
      errors.push({ field: `items[${i}].name`, message: `Workgroup name must be ${WORKGROUP_NAME_MAX} characters or fewer.`, code: 'NAME_TOO_LONG' })
    }

    if (organizationId && !isGuid(organizationId)) {
      errors.push({ field: `items[${i}].organizationId`, message: 'Organization ID must be a GUID, e.g. 00000000-0000-0000-0000-000000000000.', code: 'INVALID_ORG_ID' })
    }

    if (name) {
      const identity = workgroupIdentity(name)
      if (seen.has(identity)) {
        warnings.push({ field: `items[${i}].name`, message: `Workgroup ${name} is listed more than once; the last one wins.`, code: 'DUPLICATE_WORKGROUP' })
      } else {
        seen.add(identity)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
