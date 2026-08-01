import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractMembershipSpecs } from './_shared'

/**
 * Validate Group Membership items: a non-empty, unique target group name and a
 * members list (each entry an email, username or raw user id). Static — no target
 * access required; unresolved members surface at deploy time (they need the org's
 * user directory to resolve).
 *
 * An empty members list is accepted but warned about: in exclusive mode it would
 * EMPTY the group, which is rarely intended.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const specs = extractMembershipSpecs(ctx.canvas)

  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one group membership.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.groupName) {
      errors.push({ field: `${prefix}.groupName`, message: 'User Group name is required.', code: 'EMPTY_GROUP' })
    } else if (spec.groupName.length > 255) {
      errors.push({ field: `${prefix}.groupName`, message: 'User Group name must be 255 characters or fewer.', code: 'MAX_LENGTH' })
    } else if (seen.has(spec.groupName.toLowerCase())) {
      errors.push({
        field: `${prefix}.groupName`,
        message: `Duplicate group "${spec.groupName}" — declare each group's membership only once per canvas.`,
        code: 'DUPLICATE_GROUP',
      })
    } else {
      seen.add(spec.groupName.toLowerCase())
    }

    if (spec.members.length === 0) {
      warnings.push({
        field: `${prefix}.members`,
        message: spec.exclusive
          ? `"${spec.groupName || 'group'}" lists no members and manages membership exclusively — deploying will REMOVE all current members.`
          : `"${spec.groupName || 'group'}" lists no members — nothing will be added.`,
        code: 'NO_MEMBERS',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
