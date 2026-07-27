import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC Provisioning Policy constraints ---------------------------
// A provisioning policy is a nested child of a source, keyed within its parent by
// `usageType` (a fixed enum). The parent source is resolved by name → id.

export const USAGE_TYPES = [
  'CREATE',
  'UPDATE',
  'ENABLE',
  'DISABLE',
  'UNLOCK',
  'REGISTER',
  'CREATE_IDENTITY',
  'EDIT_IDENTITY',
  'CHANGE_PASSWORD',
] as const

export interface ProvisioningPolicySpec {
  itemId?: string
  /** name of the parent source (resolved to an id at deploy time). */
  sourceName: string
  /** the policy usageType — the key within the source. */
  usageType: string
  name: string
  description: string
  /** raw JSON for the `fields` array (FieldDetailsDto[]). */
  fieldsRaw: string
}

/** A provisioning policy as returned by GET /v3/sources/{id}/provisioning-policies. */
export interface LiveProvisioningPolicy {
  name?: string
  description?: string | null
  usageType?: string
  fields?: Array<Record<string, unknown>>
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function parseJsonArray(
  raw: string
): { ok: true; value: unknown[] } | { ok: false; error: string } {
  if (!raw) return { ok: true, value: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid JSON' }
  }
  if (!Array.isArray(parsed)) return { ok: false, error: 'must be a JSON array' }
  return { ok: true, value: parsed }
}

export function extractProvisioningPolicySpecs(canvas: CanvasSnapshot): ProvisioningPolicySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      sourceName: asString(f.sourceName),
      usageType: asString(f.usageType) || 'CREATE',
      name: asString(f.name) || item.name,
      description: asString(f.description),
      fieldsRaw:
        typeof f.fields === 'string'
          ? f.fields.trim()
          : Array.isArray(f.fields)
            ? JSON.stringify(f.fields)
            : '',
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractProvisioningPolicySpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.sourceName) {
      errors.push({ field: `${prefix}.sourceName`, message: 'A parent source name is required', code: 'required' })
    }
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    }
    if (!USAGE_TYPES.includes(spec.usageType as (typeof USAGE_TYPES)[number])) {
      errors.push({ field: `${prefix}.usageType`, message: `Usage type must be one of ${USAGE_TYPES.join(', ')}`, code: 'invalid_enum' })
    }

    if (spec.sourceName && spec.usageType) {
      const key = `${spec.sourceName.toLowerCase()}::${spec.usageType}`
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.usageType`, message: `Duplicate ${spec.usageType} provisioning policy for source "${spec.sourceName}"`, code: 'duplicate_usage' })
      }
      seen.add(key)
    }

    const parsed = parseJsonArray(spec.fieldsRaw)
    if (!parsed.ok) {
      errors.push({ field: `${prefix}.fields`, message: `Fields must be a JSON array: ${parsed.error}`, code: 'invalid_fields' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
