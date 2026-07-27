import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Prisma Cloud user role constraints --------------------------------------

export const MAX_NAME_LENGTH = 255
export const MAX_DESC_LENGTH = 2000

/**
 * Built-in roleType values. A custom Permission Group name is ALSO a valid
 * roleType, so this list is used only for advisory warnings — never to reject.
 */
export const KNOWN_ROLE_TYPES = [
  'System Admin',
  'Account Group Admin',
  'Account Group Read Only',
  'Cloud Provisioning Admin',
  'Account and Cloud Provisioning Admin',
  'Build and Deploy Security',
]

/** roleTypes that operate against account groups — they expect account group ids. */
export const ACCOUNT_SCOPED_ROLE_TYPES = [
  'Account Group Admin',
  'Account Group Read Only',
  'Cloud Provisioning Admin',
  'Account and Cloud Provisioning Admin',
]

export interface RoleSpec {
  itemId?: string
  /** name — the identity (Prisma matches roles by name). */
  name: string
  roleType: string
  description: string
  /** accessible account group ids. */
  accountGroupIds: string[]
  /** associated resource list ids. */
  resourceListIds: string[]
  restrictDismissalAccess: boolean
}

/** A role as returned by GET /user/role. */
export interface LiveRole {
  id?: string
  name?: string
  roleType?: string
  description?: string | null
  accountGroupIds?: string[]
  resourceListIds?: string[]
  restrictDismissalAccess?: boolean
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

export function splitIds(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map((x) => String(x).trim()) : asString(v).split(/[\n,]/).map((t) => t.trim())
  return [...new Set(raw.filter((t) => t.length > 0))]
}

export function extractRoleSpecs(canvas: CanvasSnapshot): RoleSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      roleType: asString(f.roleType),
      description: asString(f.description),
      accountGroupIds: splitIds(f.accountGroupIds),
      resourceListIds: splitIds(f.resourceListIds),
      restrictDismissalAccess: asBool(f.restrictDismissalAccess),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractRoleSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate role "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.roleType) {
      errors.push({ field: `${prefix}.roleType`, message: 'Role type is required (a built-in role type or a custom permission group name)', code: 'required' })
    }

    if (spec.description.length > MAX_DESC_LENGTH) {
      errors.push({ field: `${prefix}.description`, message: `Description must be ${MAX_DESC_LENGTH} characters or fewer`, code: 'too_long' })
    }

    if (spec.roleType && ACCOUNT_SCOPED_ROLE_TYPES.includes(spec.roleType) && spec.accountGroupIds.length === 0) {
      warnings.push({ field: `${prefix}.accountGroupIds`, message: `Role type "${spec.roleType}" is scoped to account groups but no account group ids are set`, code: 'empty_account_groups' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
