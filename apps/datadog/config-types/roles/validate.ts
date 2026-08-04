import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { MAX_NAME_LENGTH, extractRoleSpecs, roleKey, type RoleSpec } from './_shared'

/**
 * Validate Role items — static, no network access.
 *   - name is required, <= 255 chars, unique across the canvas.
 *   - a role with no permissions is allowed (it just grants nothing) but
 *     surfaces a warning, since that is rarely intentional.
 *
 * Permission NAMES themselves are resolved (and validated as recognized)
 * against the live Datadog permission catalog in deploy.ts — that requires
 * network access this static validator does not have.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one Role.', code: 'EMPTY' })
    return { valid: false, errors, warnings }
  }

  const specs = extractRoleSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    validateOne(spec, i, errors, warnings)
    if (spec.name) {
      const key = roleKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `items[${i}].name`,
          message: `Duplicate role name "${spec.name}" — each name may only be declared once (roles are matched by name).`,
          code: 'DUPLICATE_NAME',
        })
      }
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}

function validateOne(spec: RoleSpec, i: number, errors: ValidationError[], warnings: ValidationWarning[]): void {
  const prefix = `items[${i}]`

  if (!spec.name) {
    errors.push({ field: `${prefix}.name`, message: 'Role name is required.', code: 'EMPTY_NAME' })
  } else if (spec.name.length > MAX_NAME_LENGTH) {
    errors.push({ field: `${prefix}.name`, message: `Role name must be ${MAX_NAME_LENGTH} characters or fewer.`, code: 'NAME_TOO_LONG' })
  }

  if (spec.permissionNames.length === 0) {
    warnings.push({ field: `${prefix}.permissions`, message: 'This role grants no permissions.', code: 'NO_PERMISSIONS' })
  }
}
