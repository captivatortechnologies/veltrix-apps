import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { extractGlobalResourceSpecs, READ_ACCESS_VALUES } from './_shared'

/**
 * Validate Global Resource items. Static — no target access required:
 *   - name, team_id and value are required
 *   - read_access must be one of TEAM / GLOBAL / SPECIFIC_TEAMS
 *   - SPECIFIC_TEAMS requires at least one shared_team_slugs entry
 *   - (team_id, name) must be unique across the canvas (its reconciliation identity)
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  const specs = extractGlobalResourceSpecs(ctx.canvas)
  if (specs.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Global Resource.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Resource name is required.', code: 'EMPTY_NAME' })
    }
    if (!spec.teamId) {
      errors.push({ field: `${prefix}.team_id`, message: 'Team is required.', code: 'EMPTY_TEAM' })
    }
    if (!spec.value) {
      errors.push({ field: `${prefix}.value`, message: 'Value is required.', code: 'EMPTY_VALUE' })
    }
    if (!(READ_ACCESS_VALUES as readonly string[]).includes(spec.readAccess)) {
      errors.push({
        field: `${prefix}.read_access`,
        message: `read_access must be one of: ${READ_ACCESS_VALUES.join(', ')}.`,
        code: 'INVALID_READ_ACCESS',
      })
    } else if (spec.readAccess === 'SPECIFIC_TEAMS' && spec.sharedTeamSlugs.length === 0) {
      errors.push({
        field: `${prefix}.shared_team_slugs`,
        message: 'At least one team slug is required when Read Access is Specific teams.',
        code: 'EMPTY_SHARED_TEAMS',
      })
    }

    if (spec.name && spec.teamId) {
      const key = `${spec.teamId}::${spec.name.toLowerCase()}`
      if (seen.has(key)) {
        warnings.push({
          field: `${prefix}.name`,
          message: `Resource "${spec.name}" is listed more than once for this team; the last one wins.`,
          code: 'DUPLICATE_NAME',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
