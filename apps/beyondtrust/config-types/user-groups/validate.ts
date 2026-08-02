import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { GROUP_DESCRIPTION_MAX, GROUP_NAME_MAX, groupIdentity, str } from './_shared'

/**
 * Validate user-group items: a non-empty group name within Password Safe's
 * length limit, and a description (required by the API for BeyondInsight groups)
 * within its limit. Static — no target access required. The group name is the
 * identity, so a duplicate is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one user group.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const groupName = str(item.fields.groupName)
    const description = str(item.fields.description)

    if (!groupName) {
      errors.push({ field: `items[${i}].groupName`, message: 'Group name is required.', code: 'EMPTY_GROUP_NAME' })
    } else if (groupName.length > GROUP_NAME_MAX) {
      errors.push({ field: `items[${i}].groupName`, message: `Group name must be ${GROUP_NAME_MAX} characters or fewer.`, code: 'GROUP_NAME_TOO_LONG' })
    }

    if (!description) {
      errors.push({ field: `items[${i}].description`, message: 'Description is required for a BeyondInsight user group.', code: 'EMPTY_DESCRIPTION' })
    } else if (description.length > GROUP_DESCRIPTION_MAX) {
      errors.push({ field: `items[${i}].description`, message: `Description must be ${GROUP_DESCRIPTION_MAX} characters or fewer.`, code: 'DESCRIPTION_TOO_LONG' })
    }

    if (groupName) {
      const identity = groupIdentity(groupName)
      if (seen.has(identity)) {
        warnings.push({ field: `items[${i}].groupName`, message: `User group ${groupName} is listed more than once; the last one wins.`, code: 'DUPLICATE_GROUP' })
      } else {
        seen.add(identity)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
