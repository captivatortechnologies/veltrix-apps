import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { SOPHOS_ROLE_PRINCIPAL_TYPES } from '../../lib/sophosApi'
import { customRoleKey, extractCustomRoleSpecs } from './_shared'

/**
 * Validate custom role(s): a required unique `name`, a known
 * `principalType`, and at least one permission set. Static — no target
 * access.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one custom role.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const specs = extractCustomRoleSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Role name is required.', code: 'REQUIRED' })
    } else {
      const key = customRoleKey(spec.name)
      if (seen.has(key)) {
        warnings.push({ field: `${prefix}.name`, message: `Role "${spec.name}" is listed more than once; the last one wins.`, code: 'DUPLICATE_NAME' })
      } else {
        seen.add(key)
      }
    }

    if (!spec.principalType) {
      errors.push({ field: `${prefix}.principalType`, message: 'Principal type is required.', code: 'REQUIRED' })
    } else if (!(SOPHOS_ROLE_PRINCIPAL_TYPES as readonly string[]).includes(spec.principalType)) {
      errors.push({
        field: `${prefix}.principalType`,
        message: `"${spec.principalType}" must be one of ${SOPHOS_ROLE_PRINCIPAL_TYPES.join(', ')}.`,
        code: 'INVALID_PRINCIPAL_TYPE',
      })
    }

    if (spec.permissionSets.length === 0) {
      errors.push({ field: `${prefix}.permissionSets`, message: 'At least one permission set is required.', code: 'REQUIRED' })
    }
    const dupePermissions = spec.permissionSets.filter((p, idx) => spec.permissionSets.indexOf(p) !== idx)
    if (dupePermissions.length > 0) {
      warnings.push({
        field: `${prefix}.permissionSets`,
        message: `Duplicate permission set(s) ignored: ${[...new Set(dupePermissions)].join(', ')}.`,
        code: 'DUPLICATE_PERMISSION_SET',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
