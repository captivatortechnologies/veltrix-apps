import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { isMalformedUserRolesJson, parseUserRoles, BUILTIN_TEAM_ROLES } from './_shared'

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const SCOPE_BY = new Set(['container', 'host'])

/**
 * Validate team items: a non-empty unique name, a valid theme color, a known
 * scopeBy, well-formed userRolesJson, and at most one default team. Static —
 * no target access required.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one team.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  let defaultCount = 0

  items.forEach((item, i) => {
    const name = String(item.fields.name ?? '').trim()
    const p = (field: string) => `items[${i}].${field}`

    if (!name) {
      errors.push({ field: p('name'), message: 'Team name is required.', code: 'EMPTY_NAME' })
    } else if (seen.has(name)) {
      warnings.push({ field: p('name'), message: `Team name "${name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
    } else {
      seen.add(name)
    }

    const theme = String(item.fields.theme ?? '').trim()
    if (theme && !HEX_COLOR_RE.test(theme)) {
      errors.push({ field: p('theme'), message: `Theme must be a #RGB or #RRGGBB hex color (got "${theme}").`, code: 'INVALID_THEME' })
    }

    const scopeBy = String(item.fields.scopeBy ?? 'container').trim()
    if (!SCOPE_BY.has(scopeBy)) {
      errors.push({ field: p('scopeBy'), message: `Scope By must be one of ${[...SCOPE_BY].join(', ')} (got "${scopeBy}").`, code: 'INVALID_SCOPE_BY' })
    }

    if (isMalformedUserRolesJson(item.fields.userRolesJson)) {
      errors.push({ field: p('userRolesJson'), message: 'User Roles must be valid JSON: an array of {email, role}.', code: 'INVALID_USER_ROLES_JSON' })
    } else {
      for (const role of parseUserRoles(item.fields.userRolesJson)) {
        if (!BUILTIN_TEAM_ROLES.has(role.role) && !/^\d+$/.test(role.role)) {
          warnings.push({
            field: p('userRolesJson'),
            message: `Role "${role.role}" for ${role.email} is not a built-in role name or numeric custom-role id.`,
            code: 'UNKNOWN_ROLE',
          })
        }
      }
    }

    if (String(item.fields.defaultTeam) === 'true' || item.fields.defaultTeam === true) defaultCount++
  })

  if (defaultCount > 1) {
    warnings.push({
      field: 'items',
      message: `${defaultCount} teams are marked as the Default Team — only one should be. Sysdig will keep reconciling this on every deploy.`,
      code: 'MULTIPLE_DEFAULT_TEAMS',
    })
  }

  return { valid: errors.length === 0, errors, warnings }
}
