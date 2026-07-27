import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC Role Dimension constraints --------------------------------
// A dimension is a nested child of a role, keyed within its parent by `name`. The
// parent role is resolved by name → id first.

export const MAX_NAME_LENGTH = 128
export const OWNER_TYPES = ['IDENTITY', 'GOVERNANCE_GROUP'] as const

export interface DimensionSpec {
  itemId?: string
  /** name of the parent role (resolved to an id at deploy time). */
  roleName: string
  name: string
  description: string
  ownerType: string
  ownerId: string
  accessProfileIds: string[]
  entitlementIds: string[]
  /** raw JSON for the optional `membership` selector. */
  membershipRaw: string
}

/** A dimension as returned by GET /beta/roles/{roleId}/dimensions. */
export interface LiveDimension {
  id?: string
  name?: string
  description?: string | null
  owner?: { id?: string; type?: string }
  accessProfiles?: Array<{ id?: string }>
  entitlements?: Array<{ id?: string }>
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function toIdList(v: unknown): string[] {
  const raw = Array.isArray(v)
    ? v.map((x) => String(x).trim())
    : typeof v === 'string'
      ? v.split(/[,\n]/).map((s) => s.trim())
      : []
  return [...new Set(raw.filter((s) => s.length > 0))]
}

export function parseJsonObject(
  raw: string
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (!raw) return { ok: true, value: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'must be a JSON object' }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

export function extractDimensionSpecs(canvas: CanvasSnapshot): DimensionSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      roleName: asString(f.roleName),
      name: asString(f.name) || item.name,
      description: asString(f.description),
      ownerType: asString(f.ownerType) || 'IDENTITY',
      ownerId: asString(f.ownerId),
      accessProfileIds: toIdList(f.accessProfileIds),
      entitlementIds: toIdList(f.entitlementIds),
      membershipRaw:
        typeof f.membership === 'string'
          ? f.membership.trim()
          : f.membership && typeof f.membership === 'object'
            ? JSON.stringify(f.membership)
            : '',
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractDimensionSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.roleName) {
      errors.push({ field: `${prefix}.roleName`, message: 'A parent role name is required', code: 'required' })
    }
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else if (spec.name.length > MAX_NAME_LENGTH) {
      errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
    }
    if (!spec.ownerId) {
      errors.push({ field: `${prefix}.ownerId`, message: 'An owner id is required', code: 'required' })
    }
    if (!OWNER_TYPES.includes(spec.ownerType as (typeof OWNER_TYPES)[number])) {
      errors.push({ field: `${prefix}.ownerType`, message: `Owner type must be one of ${OWNER_TYPES.join(', ')}`, code: 'invalid_enum' })
    }

    if (spec.roleName && spec.name) {
      const key = `${spec.roleName.toLowerCase()}::${spec.name.toLowerCase()}`
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate dimension "${spec.name}" for role "${spec.roleName}"`, code: 'duplicate_name' })
      }
      seen.add(key)
    }

    const parsed = parseJsonObject(spec.membershipRaw)
    if (!parsed.ok) {
      errors.push({ field: `${prefix}.membership`, message: `Membership must be a JSON object: ${parsed.error}`, code: 'invalid_membership' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
