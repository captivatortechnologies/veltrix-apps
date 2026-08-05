import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractTeamMemberSpecs, isValidEmail } from './_shared'

/**
 * Validate Team Member items. Static — no target access required:
 *   - team_id and email are required; email must look like an email address
 *   - (team_id, email) must be unique across the canvas (its reconciliation identity)
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  const specs = extractTeamMemberSpecs(ctx.canvas)
  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one team member.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.teamId) {
      errors.push({ field: `${prefix}.team_id`, message: 'Team is required.', code: 'EMPTY_TEAM' })
    }
    if (!spec.email) {
      errors.push({ field: `${prefix}.email`, message: 'Email is required.', code: 'EMPTY_EMAIL' })
    } else if (!isValidEmail(spec.email)) {
      errors.push({ field: `${prefix}.email`, message: `"${spec.email}" does not look like a valid email address.`, code: 'INVALID_EMAIL' })
    }

    if (spec.teamId && spec.email) {
      const key = `${spec.teamId}::${spec.email}`
      if (seen.has(key)) {
        warnings.push({
          field: `${prefix}.email`,
          message: `"${spec.email}" is listed more than once for this team; the last one wins.`,
          code: 'DUPLICATE_MEMBER',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
