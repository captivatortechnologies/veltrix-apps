import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- FortiManager user group constraints -------------------------------------

export const MAX_NAME_LENGTH = 79
export const GROUP_TYPES = ['firewall', 'directory-service', 'fsso-service', 'guest', 'rsso'] as const
export const LOGIC_TYPES = ['or', 'and'] as const

export interface UserGroupSpec {
  itemId?: string
  /** name — the mkey / identity. */
  name: string
  /** firewall | directory-service | fsso-service | guest | rsso. */
  groupType: string
  /** Member names — local users and LDAP / RADIUS / FSSO server names. */
  members: string[]
  authTimeout: string
  /** or | and (empty leaves the FortiManager default). */
  logicType: string
}

/** A user group as returned by a get on the user/group table. */
export interface LiveUserGroup {
  name?: string
  'group-type'?: string | number
  /** member is an array of names or {name} objects depending on the get option. */
  member?: Array<string | { name?: string }>
  authtimeout?: string | number
  'logic-type'?: string | number
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''
}

/** Split a member value into trimmed names (by newline or comma). */
export function splitMembers(v: unknown): string[] {
  const raw = Array.isArray(v) ? v.map((x) => String(x).trim()) : asString(v).split(/[\n,]/).map((t) => t.trim())
  return [...new Set(raw.filter((t) => t.length > 0))]
}

/** Normalize a live member array to plain names. */
export function liveMemberNames(v: LiveUserGroup['member']): string[] {
  return (v ?? []).map((m) => (typeof m === 'string' ? m : m?.name ?? '')).filter((n) => n.length > 0)
}

export function extractUserGroupSpecs(canvas: CanvasSnapshot): UserGroupSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      groupType: (asString(f.groupType) || 'firewall').toLowerCase(),
      members: splitMembers(f.members),
      authTimeout: asString(f.authTimeout),
      logicType: asString(f.logicType).toLowerCase(),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractUserGroupSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate user group "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!(GROUP_TYPES as readonly string[]).includes(spec.groupType)) {
      errors.push({ field: `${prefix}.groupType`, message: `Group type must be one of: ${GROUP_TYPES.join(', ')}`, code: 'invalid_group_type' })
    }

    // Members reference existing local users / auth servers by name — presence is
    // validated here, but the referenced objects are not resolved.
    if (spec.members.length === 0) {
      errors.push({ field: `${prefix}.members`, message: 'A user group needs at least one member', code: 'missing_members' })
    }

    if (spec.logicType && !(LOGIC_TYPES as readonly string[]).includes(spec.logicType)) {
      errors.push({ field: `${prefix}.logicType`, message: `Logic type must be one of: ${LOGIC_TYPES.join(', ')}`, code: 'invalid_logic_type' })
    }

    if (spec.authTimeout) {
      const n = Number(spec.authTimeout)
      if (!Number.isInteger(n) || n < 0) {
        errors.push({ field: `${prefix}.authTimeout`, message: 'Auth timeout must be a non-negative integer (minutes)', code: 'invalid_authtimeout' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
