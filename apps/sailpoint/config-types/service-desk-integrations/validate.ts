import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC Service Desk Integration (SDIM) constraints ----------------
// `attributes` carries provider credentials (secret-bearing): it is written on
// deploy but GET masks it, so drift/rollback round-trip the scalar fields only.

export const MAX_NAME_LENGTH = 128

export interface ServiceDeskSpec {
  itemId?: string
  name: string
  description: string
  /** integration type, e.g. "ServiceNowSDIM" (immutable). */
  type: string
  ownerId: string
  clusterId: string
  /** raw JSON for the provider-specific `attributes` object (secret-bearing). */
  attributesRaw: string
}

/** A service desk integration as returned by GET /v3/service-desk-integrations. */
export interface LiveServiceDesk {
  id?: string
  name?: string
  description?: string | null
  type?: string
  ownerRef?: { id?: string } | null
  clusterRef?: { id?: string } | null
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
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

export function extractServiceDeskSpecs(canvas: CanvasSnapshot): ServiceDeskSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      type: asString(f.type),
      ownerId: asString(f.ownerId),
      clusterId: asString(f.clusterId),
      attributesRaw:
        typeof f.attributes === 'string'
          ? f.attributes.trim()
          : f.attributes && typeof f.attributes === 'object'
            ? JSON.stringify(f.attributes)
            : '',
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractServiceDeskSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate service desk integration "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'An integration type is required (e.g. "ServiceNowSDIM")', code: 'required' })
    }

    const parsed = parseJsonObject(spec.attributesRaw)
    if (!parsed.ok) {
      errors.push({ field: `${prefix}.attributes`, message: `Attributes must be a JSON object: ${parsed.error}`, code: 'invalid_attributes' })
    } else if (!spec.attributesRaw) {
      warnings.push({ field: `${prefix}.attributes`, message: 'A service desk integration usually needs connection attributes', code: 'empty_attributes' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
