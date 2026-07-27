import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC SIM Integration constraints -------------------------------
// The older cousin of Service Desk Integrations. `attributes` is secret-bearing:
// written on deploy but not drift-tracked (GET masks it).

export const MAX_NAME_LENGTH = 128

export interface SimIntegrationSpec {
  itemId?: string
  name: string
  description: string
  /** integration type, e.g. "ServiceNow Service Desk" (immutable). */
  type: string
  /** proxy cluster id. */
  cluster: string
  /** managed resource ids. */
  sources: string[]
  /** raw JSON for the provider-specific `attributes` object (secret-bearing). */
  attributesRaw: string
}

/** A SIM integration as returned by GET /beta/sim-integrations. */
export interface LiveSimIntegration {
  id?: string
  name?: string
  description?: string | null
  type?: string
  cluster?: string
  sources?: string[]
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

export function extractSimIntegrationSpecs(canvas: CanvasSnapshot): SimIntegrationSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      type: asString(f.type),
      cluster: asString(f.cluster),
      sources: toIdList(f.sources),
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
  const specs = extractSimIntegrationSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate SIM integration "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'An integration type is required', code: 'required' })
    }
    if (!spec.cluster) {
      errors.push({ field: `${prefix}.cluster`, message: 'A proxy cluster id is required', code: 'required' })
    }

    const parsed = parseJsonObject(spec.attributesRaw)
    if (!parsed.ok) {
      errors.push({ field: `${prefix}.attributes`, message: `Attributes must be a JSON object: ${parsed.error}`, code: 'invalid_attributes' })
    } else if (!spec.attributesRaw) {
      warnings.push({ field: `${prefix}.attributes`, message: 'A SIM integration usually needs connection attributes', code: 'empty_attributes' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
