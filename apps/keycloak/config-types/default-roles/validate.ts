import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { parseJsonField, readStringArray } from '../../lib/fields'
import { isClientRoleMapShape } from './_shared'

/**
 * Validate the default-roles singleton: exactly one item is declared;
 * `realmRoles` is a de-duped tag list (no format constraint — existence against
 * the realm is checked at deploy time); `clientRoles`, when present, must be
 * valid JSON parsing to a plain object whose every value is an array of
 * non-empty role-name strings. Warns when both fields end up empty — deploying
 * that removes every current composite from the realm's default role,
 * including Keycloak's own auto-created ones (offline_access,
 * uma_authorization). Static — no target access.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({
      field: 'items',
      message: 'Default Roles has no configuration — add the singleton item.',
      code: 'EMPTY',
    })
    return { valid: false, errors, warnings }
  }
  if (items.length > 1) {
    errors.push({
      field: 'items',
      message: 'Default Roles is a realm-wide singleton — declare exactly one item.',
      code: 'MULTIPLE_ITEMS',
    })
  }

  items.forEach((item, i) => {
    const realmRoles = readStringArray(item.fields.realmRoles)

    const parsed = parseJsonField(item.fields.clientRoles)
    let clientRoleCount = 0
    if (!parsed.ok) {
      errors.push({
        field: `items[${i}].clientRoles`,
        message: 'Client roles must be valid JSON, e.g. {"account": ["view-profile"]}.',
        code: 'INVALID_CLIENT_ROLES_JSON',
      })
    } else if (parsed.value !== undefined) {
      if (!isClientRoleMapShape(parsed.value)) {
        errors.push({
          field: `items[${i}].clientRoles`,
          message:
            'Client roles must be a JSON object mapping each clientId to an array of non-empty role name strings, e.g. {"account": ["view-profile","manage-account"]}.',
          code: 'INVALID_CLIENT_ROLES_SHAPE',
        })
      } else {
        clientRoleCount = Object.keys(parsed.value).length
      }
    }

    if (realmRoles.length === 0 && clientRoleCount === 0) {
      warnings.push({
        field: `items[${i}]`,
        message:
          "No realm roles or client roles declared — deploying this removes every current composite from the realm's default role, including Keycloak's own auto-created ones (offline_access, uma_authorization). Declare them explicitly to keep them.",
        code: 'EMPTY_DEFAULT_ROLES',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
