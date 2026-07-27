import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Carbon Black asset group constraints ------------------------------------

/** The only member type this config type manages (device grouping). */
export const MEMBER_TYPES = ['DEVICE'] as const

export interface AssetGroupSpec {
  itemId?: string
  /** name — the group's identity (groups are id-addressed; matched by name). */
  name: string
  description: string
  memberType: string
  /** Lucene dynamic-membership criteria (e.g. os.equals:WINDOWS). */
  query: string
  /** optional Policy Service policy id applied to matching devices. */
  policyId: string
}

/** An asset group as returned by the asset-groups service. */
export interface LiveAssetGroup {
  id?: string
  name?: string
  description?: string
  member_type?: string
  query?: string
  policy_id?: number | string
  status?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractAssetGroupSpecs(canvas: CanvasSnapshot): AssetGroupSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      memberType: (asString(f.memberType) || 'DEVICE').toUpperCase(),
      query: asString(f.query),
      policyId: asString(f.policyId),
    }
  })
}

const INT_RE = /^\d+$/

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAssetGroupSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) errors.push({ field: `${prefix}.name`, message: `Duplicate asset group "${spec.name}"`, code: 'duplicate_name' })
      seen.add(key)
    }

    if (!spec.description) errors.push({ field: `${prefix}.description`, message: 'Description is required', code: 'required' })

    if (!(MEMBER_TYPES as readonly string[]).includes(spec.memberType)) {
      errors.push({ field: `${prefix}.memberType`, message: `Member type must be one of: ${MEMBER_TYPES.join(', ')}`, code: 'invalid_member_type' })
    }

    if (spec.policyId && !INT_RE.test(spec.policyId)) {
      errors.push({ field: `${prefix}.policyId`, message: 'Policy ID must be an integer', code: 'invalid_policy_id' })
    }

    // This config type manages DYNAMIC (query-based) groups; a group with no
    // query and no policy is inert (static membership is out of scope).
    if (!spec.query && !spec.policyId) {
      warnings.push({ field: `${prefix}.query`, message: 'This group has no dynamic query and no policy — it will contain no members', code: 'empty_group' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
