import type { PipelineContext, ValidationResult, ValidationError, ValidationWarning } from '@veltrixsecops/app-sdk'
import { readString } from '../../lib/fields'
import { DECISION_STRATEGIES, KINDS, PERMISSION_TYPES, POLICY_LOGIC, parseRoleEntriesField } from './_shared'

/**
 * Validate authorization items: a client reference, a known kind, and a
 * non-empty name. Unlike this app's other identity fields (clientId, role
 * names, mapper names), no whitespace restriction is applied to `name` —
 * Keycloak resource/scope/permission/policy names commonly contain spaces
 * (e.g. Keycloak's own default "Default Resource" / "Default Permission").
 * Per-kind: permission requires a valid permissionType; permission and
 * role-policy validate decisionStrategy against its enum when present;
 * role-policy validates logic and requires a well-formed, non-empty roles
 * JSON array. Static (no target access) — the referenced client and any
 * referenced scope/resource/policy/role are resolved and checked to exist at
 * deploy time. The identity is the COMPOSITE (clientId, kind, name): the same
 * name may legitimately exist as, say, a resource AND a scope on one client.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Add at least one authorization object.', code: 'EMPTY' })
  }

  const seen = new Set<string>()
  items.forEach((item, i) => {
    const clientId = readString(item.fields.clientId)
    const kind = readString(item.fields.kind)
    const name = readString(item.fields.name)

    if (!clientId) {
      errors.push({ field: `items[${i}].clientId`, message: 'Client ID is required.', code: 'EMPTY_CLIENT_ID' })
    }

    if (!kind) {
      errors.push({ field: `items[${i}].kind`, message: 'Kind is required.', code: 'EMPTY_KIND' })
    } else if (!KINDS.has(kind)) {
      errors.push({
        field: `items[${i}].kind`,
        message: `Kind must be one of resource, scope, permission, role-policy (got "${kind}").`,
        code: 'INVALID_KIND',
      })
    }

    if (!name) {
      errors.push({ field: `items[${i}].name`, message: 'Name is required.', code: 'EMPTY_NAME' })
    }

    if (kind === 'permission') {
      const permissionType = readString(item.fields.permissionType)
      if (!permissionType) {
        errors.push({
          field: `items[${i}].permissionType`,
          message: 'Permission type is required for a permission.',
          code: 'EMPTY_PERMISSION_TYPE',
        })
      } else if (!PERMISSION_TYPES.has(permissionType)) {
        errors.push({
          field: `items[${i}].permissionType`,
          message: `Permission type must be one of resource, scope (got "${permissionType}").`,
          code: 'INVALID_PERMISSION_TYPE',
        })
      }
    }

    if (kind === 'permission' || kind === 'role-policy') {
      const decisionStrategy = readString(item.fields.decisionStrategy)
      if (decisionStrategy && !DECISION_STRATEGIES.has(decisionStrategy)) {
        errors.push({
          field: `items[${i}].decisionStrategy`,
          message: `Decision strategy must be one of UNANIMOUS, AFFIRMATIVE, CONSENSUS (got "${decisionStrategy}").`,
          code: 'INVALID_DECISION_STRATEGY',
        })
      }
    }

    if (kind === 'role-policy') {
      const logic = readString(item.fields.logic)
      if (logic && !POLICY_LOGIC.has(logic)) {
        errors.push({
          field: `items[${i}].logic`,
          message: `Logic must be one of POSITIVE, NEGATIVE (got "${logic}").`,
          code: 'INVALID_LOGIC',
        })
      }

      const { error } = parseRoleEntriesField(item.fields.roles)
      if (error) {
        errors.push({ field: `items[${i}].roles`, message: error, code: 'INVALID_ROLES' })
      }
    }

    if (clientId && kind && name) {
      const key = `${clientId}::${kind}::${name}`
      if (seen.has(key)) {
        warnings.push({
          field: `items[${i}].name`,
          message: `"${name}" (${kind}) on client "${clientId}" is listed more than once; the last one wins.`,
          code: 'DUPLICATE_ITEM',
        })
      } else {
        seen.add(key)
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
