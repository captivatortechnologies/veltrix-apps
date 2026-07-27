import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- FortiManager custom Internet Service constraints ------------------------

export const MAX_NAME_LENGTH = 79

export interface InternetServiceCustomSpec {
  itemId?: string
  /** name — the mkey / identity. */
  name: string
  comment: string
  reputation?: number
  masterServiceId?: number
  /** Raw JSON for the entry list (validated to parse to an array). */
  entry: string
}

/** A custom internet service as returned by a get on the table. */
export interface LiveInternetServiceCustom {
  name?: string
  comment?: string
  reputation?: number | string
  'master-service-id'?: number | string
  entry?: unknown
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim())
    if (Number.isFinite(n)) return n
  }
  return undefined
}

export interface ParsedJson {
  ok: boolean
  value?: unknown
}

/** Parse a JSON textarea value. An empty value is valid (undefined). */
export function parseJsonField(raw: string): ParsedJson {
  const t = raw.trim()
  if (!t) return { ok: true, value: undefined }
  try {
    return { ok: true, value: JSON.parse(t) }
  } catch {
    return { ok: false }
  }
}

export function extractInternetServiceCustomSpecs(canvas: CanvasSnapshot): InternetServiceCustomSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      comment: asString(f.comment),
      reputation: asNumber(f.reputation),
      masterServiceId: asNumber(f.masterServiceId),
      entry: typeof f.entry === 'string' ? f.entry : '',
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractInternetServiceCustomSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate custom internet service "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    for (const [field, value] of [
      ['reputation', spec.reputation],
      ['masterServiceId', spec.masterServiceId],
    ] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
        errors.push({ field: `${prefix}.${field}`, message: 'Value must be a non-negative integer', code: 'invalid_number' })
      }
    }

    const parsed = parseJsonField(spec.entry)
    if (!parsed.ok) {
      errors.push({ field: `${prefix}.entry`, message: 'Entry must be valid JSON', code: 'invalid_json' })
    } else if (parsed.value !== undefined && !Array.isArray(parsed.value)) {
      errors.push({ field: `${prefix}.entry`, message: 'Entry must be a JSON array', code: 'invalid_json_shape' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
