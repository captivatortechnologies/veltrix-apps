import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra unifiedRoleAssignment constraints ---------------------------------
// A role assignment has no user-facing name; its natural identity is the tuple
// (roleDefinitionId + principalId + directoryScopeId). The object is immutable —
// there is no PATCH — so reconcile matches live assignments on that tuple.

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export interface RoleAssignmentSpec {
  itemId?: string
  /** Role template GUID or a custom roleDefinition id. */
  roleDefinitionId: string
  /** Object id of the user, group or service principal. */
  principalId: string
  /** "/" (tenant-wide) or "/administrativeUnits/{id}" etc. */
  directoryScopeId: string
  /** Display-only friendly name; never sent to Graph. */
  label: string
}

/** A unifiedRoleAssignment as returned by Graph. */
export interface LiveRoleAssignment {
  id?: string
  roleDefinitionId?: string
  principalId?: string
  directoryScopeId?: string | null
  appScopeId?: string | null
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function isGuid(v: string): boolean {
  return GUID.test(v)
}

/**
 * Natural key for an assignment. Built-in roles store their roleTemplateId as the
 * roleDefinitionId, so the declared template GUID and the live value match; custom
 * roles use the custom definition id on both sides. GUIDs compare case-insensitively.
 */
export function assignmentKey(a: {
  roleDefinitionId?: string | null
  principalId?: string | null
  directoryScopeId?: string | null
}): string {
  return [a.roleDefinitionId ?? '', a.principalId ?? '', (a.directoryScopeId ?? '') || '/']
    .join('|')
    .toLowerCase()
}

export function extractRoleAssignmentSpecs(canvas: CanvasSnapshot): RoleAssignmentSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      roleDefinitionId: asString(f.roleDefinitionId),
      principalId: asString(f.principalId),
      directoryScopeId: asString(f.directoryScopeId) || '/',
      label: asString(f.label),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractRoleAssignmentSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    // roleDefinitionId / principalId / directoryScopeId are now live-picker
    // fields whose stored value is either a Graph id/shaped-scope-string
    // (the normal path) or a hand-typed display name from a canvas saved
    // before the picker existed (still valid — resolved via a live
    // displayName -> id map at deploy time, same as conditional-access-policies'
    // group/user/role fields). Neither can be verified offline without a live
    // Graph call, so an unresolvable value surfaces as a clear deploy/drift
    // error instead of a local format error here.
    if (!spec.roleDefinitionId) {
      errors.push({ field: `${prefix}.roleDefinitionId`, message: 'Role is required', code: 'required' })
    }

    if (!spec.principalId) {
      errors.push({ field: `${prefix}.principalId`, message: 'Principal is required', code: 'required' })
    }

    if (spec.roleDefinitionId && spec.principalId) {
      const key = assignmentKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.roleDefinitionId`,
          message: 'Duplicate assignment (same role, principal and scope) — declare it once per canvas',
          code: 'duplicate_assignment',
        })
      }
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
