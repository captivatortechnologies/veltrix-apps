import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- IBM QRadar reference map constraints ------------------------------------

export const ELEMENT_TYPES = ['ALN', 'ALNIC', 'IP', 'NUM', 'PORT', 'DATE'] as const

export interface MapEntry {
  key: string
  value: string
}

export interface ReferenceMapSpec {
  itemId?: string
  /** name — the reference map's identity in the classic API. */
  name: string
  /** ALN | ALNIC | IP | NUM | PORT | DATE — the VALUE element type (immutable). */
  elementType: string
  entries: MapEntry[]
}

/** A reference map as returned by GET /reference_data/maps/{name}. */
export interface LiveReferenceMap {
  name?: string
  element_type?: string
  /** data is an object keyed by the map key. */
  data?: Record<string, { value?: string }>
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Parse "key=value" lines into entries (first '=' splits key from value). */
export function parseEntries(v: unknown): MapEntry[] {
  const lines = Array.isArray(v) ? v.map((x) => String(x)) : asString(v).split(/\n/)
  const out: MapEntry[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const eq = line.indexOf('=')
    if (eq < 0) {
      out.push({ key: line, value: '' })
    } else {
      out.push({ key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim() })
    }
  }
  return out
}

export function extractReferenceMapSpecs(canvas: CanvasSnapshot): ReferenceMapSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      elementType: (asString(f.elementType) || 'ALN').toUpperCase(),
      entries: parseEntries(f.entries),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractReferenceMapSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate reference map "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!(ELEMENT_TYPES as readonly string[]).includes(spec.elementType)) {
      errors.push({ field: `${prefix}.elementType`, message: `Element type must be one of: ${ELEMENT_TYPES.join(', ')}`, code: 'invalid_element_type' })
    }

    const seenKeys = new Set<string>()
    spec.entries.forEach((e, ei) => {
      if (!e.key) errors.push({ field: `${prefix}.entries[${ei}]`, message: 'Each entry needs a key (key=value)', code: 'missing_key' })
      if (!e.value) errors.push({ field: `${prefix}.entries[${ei}]`, message: `Entry "${e.key}" needs a value (key=value)`, code: 'missing_value' })
      if (e.key && seenKeys.has(e.key.toLowerCase())) {
        errors.push({ field: `${prefix}.entries[${ei}]`, message: `Duplicate key "${e.key}" in this map`, code: 'duplicate_key' })
      }
      if (e.key) seenKeys.add(e.key.toLowerCase())
    })

    if (spec.entries.length === 0) {
      warnings.push({ field: `${prefix}.entries`, message: 'This reference map is empty', code: 'empty_map' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
