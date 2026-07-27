import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC Account Correlation Config constraints --------------------

export const MAX_NAME_LENGTH = 128

export interface CorrelationConfigSpec {
  itemId?: string
  name: string
  /** raw JSON for the `attributes` array (correlation attribute assignments). */
  attributesRaw: string
}

/** A correlation config as returned by GET /v3/correlation-config. */
export interface LiveCorrelationConfig {
  id?: string
  name?: string
  attributes?: unknown[]
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

export function extractCorrelationConfigSpecs(canvas: CanvasSnapshot): CorrelationConfigSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      attributesRaw:
        typeof f.attributes === 'string'
          ? f.attributes.trim()
          : Array.isArray(f.attributes)
            ? JSON.stringify(f.attributes)
            : '',
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractCorrelationConfigSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate correlation config "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    const parsed = parseJsonArray(spec.attributesRaw)
    if (!parsed.ok) {
      errors.push({ field: `${prefix}.attributes`, message: `Attributes must be a JSON array: ${parsed.error}`, code: 'invalid_attributes' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
