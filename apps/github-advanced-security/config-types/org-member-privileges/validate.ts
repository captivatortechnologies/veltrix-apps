import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { desiredFromItem, DEFAULT_REPOSITORY_PERMISSION_VALUES } from './_shared'

/**
 * Validate org-member-privileges items: a non-empty org and a valid default
 * repository permission. Static — no target access required. The org doubles
 * as the identity, so a duplicate is flagged (last one wins).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one organization.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const desired = desiredFromItem(item.fields)

    if (!desired.org) {
      errors.push({ field: `items[${i}].org`, message: 'Organization is required.', code: 'EMPTY_ORG' })
    } else {
      const key = desired.org.toLowerCase()
      if (seen.has(key)) {
        warnings.push({ field: `items[${i}].org`, message: `Organization ${desired.org} is listed more than once; the last one wins.`, code: 'DUPLICATE_ORG' })
      } else {
        seen.add(key)
      }
    }

    if (!DEFAULT_REPOSITORY_PERMISSION_VALUES.includes(desired.defaultRepositoryPermission as (typeof DEFAULT_REPOSITORY_PERMISSION_VALUES)[number])) {
      errors.push({
        field: `items[${i}].default_repository_permission`,
        message: `Default repository permission must be one of ${DEFAULT_REPOSITORY_PERMISSION_VALUES.join(', ')}.`,
        code: 'INVALID_DEFAULT_PERMISSION',
      })
    }

    if (!desired.members_can_create_repositories) {
      const anyCreateFlagOn =
        desired.members_can_create_public_repositories ||
        desired.members_can_create_private_repositories ||
        desired.members_can_create_internal_repositories
      if (anyCreateFlagOn) {
        warnings.push({
          field: `items[${i}].members_can_create_repositories`,
          message: 'Members can create repositories is off — the public/private/internal creation toggles below have no effect.',
          code: 'CREATE_REPOSITORIES_MASTER_SWITCH_OFF',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
