import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC Separation-of-Duties (SOD) Policy constraints --------------

export const MAX_NAME_LENGTH = 128
export const STATES = ['ENFORCED', 'NOT_ENFORCED'] as const
export const TYPES = ['GENERAL', 'CONFLICTING_ACCESS_BASED'] as const
export const OWNER_TYPES = ['IDENTITY', 'GOVERNANCE_GROUP'] as const

export interface SodPolicySpec {
  itemId?: string
  name: string
  description: string
  ownerType: string
  ownerId: string
  state: string
  type: string
  compensatingControls: string
  correctionAdvice: string
  tags: string[]
  /** search query for a GENERAL policy. */
  policyQuery: string
  /** raw JSON for `conflictingAccessCriteria` for a CONFLICTING_ACCESS_BASED policy. */
  criteriaRaw: string
}

/** An SOD policy as returned by GET /v3/sod-policies. */
export interface LiveSodPolicy {
  id?: string
  name?: string
  description?: string | null
  ownerRef?: { type?: string; id?: string }
  state?: string
  type?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function toList(v: unknown): string[] {
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

export function extractSodPolicySpecs(canvas: CanvasSnapshot): SodPolicySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      ownerType: asString(f.ownerType) || 'IDENTITY',
      ownerId: asString(f.ownerId),
      state: asString(f.state) || 'NOT_ENFORCED',
      type: asString(f.type) || 'GENERAL',
      compensatingControls: asString(f.compensatingControls),
      correctionAdvice: asString(f.correctionAdvice),
      tags: toList(f.tags),
      policyQuery: asString(f.policyQuery),
      criteriaRaw:
        typeof f.criteria === 'string'
          ? f.criteria.trim()
          : f.criteria && typeof f.criteria === 'object'
            ? JSON.stringify(f.criteria)
            : '',
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractSodPolicySpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate SOD policy "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.ownerId) {
      errors.push({ field: `${prefix}.ownerId`, message: 'An owner id is required', code: 'required' })
    }
    if (!STATES.includes(spec.state as (typeof STATES)[number])) {
      errors.push({ field: `${prefix}.state`, message: `State must be one of ${STATES.join(', ')}`, code: 'invalid_enum' })
    }
    if (!TYPES.includes(spec.type as (typeof TYPES)[number])) {
      errors.push({ field: `${prefix}.type`, message: `Type must be one of ${TYPES.join(', ')}`, code: 'invalid_enum' })
    }
    if (!OWNER_TYPES.includes(spec.ownerType as (typeof OWNER_TYPES)[number])) {
      errors.push({ field: `${prefix}.ownerType`, message: `Owner type must be one of ${OWNER_TYPES.join(', ')}`, code: 'invalid_enum' })
    }

    if (spec.type === 'CONFLICTING_ACCESS_BASED') {
      const parsed = parseJsonObject(spec.criteriaRaw)
      if (!parsed.ok) {
        errors.push({ field: `${prefix}.criteria`, message: `Conflicting access criteria must be a JSON object: ${parsed.error}`, code: 'invalid_criteria' })
      } else if (!spec.criteriaRaw) {
        errors.push({ field: `${prefix}.criteria`, message: 'A CONFLICTING_ACCESS_BASED policy requires conflictingAccessCriteria', code: 'required' })
      }
    } else if (spec.type === 'GENERAL' && !spec.policyQuery) {
      warnings.push({ field: `${prefix}.policyQuery`, message: 'A GENERAL policy usually needs a policy query', code: 'empty_query' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
