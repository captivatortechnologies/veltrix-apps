import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra custom role-definition constraints --------------------------------

export const MAX_DISPLAY_NAME_LENGTH = 256
export const MAX_DESCRIPTION_LENGTH = 1024

export interface RoleDefinitionSpec {
  itemId?: string
  /** displayName — the logical identity live role definitions are matched on. */
  name: string
  description: string
  isEnabled: boolean
  /** Allowed resource actions, e.g. microsoft.directory/applications/basic/read. */
  actions: string[]
}

/** A unified role definition as returned by Graph. */
export interface LiveRoleDefinition {
  id?: string
  displayName?: string
  description?: string | null
  isBuiltIn?: boolean
  isEnabled?: boolean
  rolePermissions?: Array<{ allowedResourceActions?: string[] }>
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

/** Split a textarea value into trimmed, non-empty action lines. */
function splitActions(v: unknown): string[] {
  return asString(v)
    .split(/[\n,]/)
    .map((a) => a.trim())
    .filter((a) => a.length > 0)
}

/** Flatten a live role definition's permissions into a single action list. */
export function liveActions(live: LiveRoleDefinition): string[] {
  return (live.rolePermissions ?? []).flatMap((p) => p.allowedResourceActions ?? [])
}

/** True when the two action collections are equal as sets. */
export function actionsEqual(a: string[], b: string[]): boolean {
  const sa = new Set(a)
  const sb = new Set(b)
  if (sa.size !== sb.size) return false
  for (const x of sa) if (!sb.has(x)) return false
  return true
}

/** Only custom (non-built-in) role definitions can be modified or deleted. */
export function isCustomRole(live: LiveRoleDefinition): boolean {
  return live.isBuiltIn !== true
}

export function extractRoleDefinitionSpecs(canvas: CanvasSnapshot): RoleDefinitionSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      isEnabled: f.isEnabled === undefined ? true : asBool(f.isEnabled),
      actions: splitActions(f.allowedResourceActions),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractRoleDefinitionSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_DISPLAY_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer`,
          code: 'too_long',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate role definition "${spec.name}" — each may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    if (spec.description.length > MAX_DESCRIPTION_LENGTH) {
      errors.push({
        field: `${prefix}.description`,
        message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`,
        code: 'too_long',
      })
    }

    // allowedResourceActions — at least one; each should be a resource action string.
    if (spec.actions.length === 0) {
      errors.push({
        field: `${prefix}.allowedResourceActions`,
        message: 'At least one allowed resource action is required',
        code: 'missing_actions',
      })
    } else {
      spec.actions.forEach((action, a) => {
        if (!action.includes('/')) {
          errors.push({
            field: `${prefix}.allowedResourceActions[${a}]`,
            message: `"${action}" is not a valid resource action (expected e.g. microsoft.directory/applications/basic/read)`,
            code: 'invalid_action',
          })
        } else if (!action.startsWith('microsoft.')) {
          warnings.push({
            field: `${prefix}.allowedResourceActions[${a}]`,
            message: `"${action}" does not start with "microsoft." — most directory actions do`,
            code: 'unexpected_action',
          })
        }
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
