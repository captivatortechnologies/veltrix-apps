import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC Transform constraints -------------------------------------

export const MIN_NAME_LENGTH = 1
export const MAX_NAME_LENGTH = 50

// Common transform types, for the canvas help text. The ISC API is authoritative
// for the full ~40-type enum and validates `type` on write, so this is a hint,
// not an allow-list — `type` is validated here only as a non-empty string.
export const COMMON_TRANSFORM_TYPES = [
  'accountAttribute',
  'concat',
  'conditional',
  'dateFormat',
  'firstValid',
  'lookup',
  'lower',
  'upper',
  'reference',
  'replace',
  'static',
  'substring',
  'trim',
]

export interface TransformSpec {
  itemId?: string
  /** name — the unique, immutable natural key ISC transforms are matched on. */
  name: string
  /** transform operation type (immutable after create). */
  type: string
  /** raw JSON text for the type-specific `attributes` object. */
  attributesRaw: string
}

/** A transform as returned by GET /transforms/v1. */
export interface LiveTransform {
  id?: string
  name?: string
  type?: string
  attributes?: Record<string, unknown>
  /** true for SailPoint-managed internal transforms — never touch these. */
  internal?: boolean
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractTransformSpecs(canvas: CanvasSnapshot): TransformSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      type: asString(f.type),
      // attributes may be authored as a string (textarea) or already an object.
      attributesRaw:
        typeof f.attributes === 'string'
          ? f.attributes.trim()
          : f.attributes && typeof f.attributes === 'object'
            ? JSON.stringify(f.attributes)
            : '',
    }
  })
}

/** Parse a spec's attributes JSON. Empty ⇒ {}. Must be a plain object. */
export function parseAttributes(
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
    return { ok: false, error: 'attributes must be a JSON object' }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractTransformSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    // name — required, length (1–50), uniqueness
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length < MIN_NAME_LENGTH || spec.name.length > MAX_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Name must be between ${MIN_NAME_LENGTH} and ${MAX_NAME_LENGTH} characters`,
          code: 'invalid_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate transform "${spec.name}" — each may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // type — required (the API validates the specific enum on write)
    if (!spec.type) {
      errors.push({
        field: `${prefix}.type`,
        message: 'Type is required (e.g. lower, concat, dateFormat, static)',
        code: 'required',
      })
    }

    // attributes — must be a valid JSON object (empty is allowed for simple types)
    const parsed = parseAttributes(spec.attributesRaw)
    if (!parsed.ok) {
      errors.push({
        field: `${prefix}.attributes`,
        message: `Attributes must be a JSON object: ${parsed.error}`,
        code: 'invalid_attributes',
      })
    } else if (spec.attributesRaw === '' && spec.type && spec.type !== 'lower' && spec.type !== 'upper') {
      // Most types need attributes; a blank object is valid JSON but usually a mistake.
      warnings.push({
        field: `${prefix}.attributes`,
        message: `The "${spec.type}" transform usually needs attributes — this one has none`,
        code: 'empty_attributes',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
