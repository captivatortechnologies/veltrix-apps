import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- FortiManager traffic shaping profile constraints ------------------------
// NOTE: this object keys on `profile-name`, NOT `name`. All set/delete/dedupe
// logic (here and in deploy) must use profile-name.

export const MAX_NAME_LENGTH = 35
export const PROFILE_TYPES = ['policing', 'queuing'] as const

export interface ShapingProfileSpec {
  itemId?: string
  /** profile-name — the mkey / identity. */
  profileName: string
  /** policing | queuing */
  type: string
  defaultClassId?: number
  comment: string
  /** Raw JSON for the shaping-entries list (validated to parse to an array). */
  shapingEntries: string
}

/** A shaping profile as returned by a get on the shaping-profile table. */
export interface LiveShapingProfile {
  'profile-name'?: string
  type?: string | number
  'default-class-id'?: number | string
  comment?: string
  'shaping-entries'?: unknown
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

export function extractShapingProfileSpecs(canvas: CanvasSnapshot): ShapingProfileSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      profileName: asString(f.profileName) || item.name,
      type: (asString(f.type) || 'policing').toLowerCase(),
      defaultClassId: asNumber(f.defaultClassId),
      comment: asString(f.comment),
      shapingEntries: typeof f.shapingEntries === 'string' ? f.shapingEntries : '',
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractShapingProfileSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.profileName) {
      errors.push({ field: `${prefix}.profileName`, message: 'Profile name is required', code: 'required' })
    } else {
      if (spec.profileName.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.profileName`, message: `Profile name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.profileName.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.profileName`, message: `Duplicate shaping profile "${spec.profileName}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!(PROFILE_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({ field: `${prefix}.type`, message: `Type must be one of: ${PROFILE_TYPES.join(', ')}`, code: 'invalid_type' })
    }

    if (spec.defaultClassId !== undefined && (!Number.isInteger(spec.defaultClassId) || spec.defaultClassId < 0)) {
      errors.push({ field: `${prefix}.defaultClassId`, message: 'Default class id must be a non-negative integer', code: 'invalid_class_id' })
    }

    const parsed = parseJsonField(spec.shapingEntries)
    if (!parsed.ok) {
      errors.push({ field: `${prefix}.shapingEntries`, message: 'Shaping entries must be valid JSON', code: 'invalid_json' })
    } else if (parsed.value !== undefined && !Array.isArray(parsed.value)) {
      errors.push({ field: `${prefix}.shapingEntries`, message: 'Shaping entries must be a JSON array', code: 'invalid_json_shape' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
