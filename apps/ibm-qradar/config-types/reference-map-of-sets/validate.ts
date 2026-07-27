import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- IBM QRadar map-of-sets constraints --------------------------------------

export const ELEMENT_TYPES = ['ALN', 'ALNIC', 'IP', 'NUM', 'PORT', 'DATE'] as const

export interface MapOfSetsEntry {
  key: string
  values: string[]
}

export interface MapOfSetsSpec {
  itemId?: string
  /** name — the map-of-sets identity in the classic API. */
  name: string
  /** ALN | ALNIC | IP | NUM | PORT | DATE — the VALUE element type (immutable). */
  elementType: string
  entries: MapOfSetsEntry[]
}

/** A map-of-sets as returned by GET /reference_data/map_of_sets/{name}. */
export interface LiveMapOfSets {
  name?: string
  element_type?: string
  /** data is an object: key -> array of value objects. */
  data?: Record<string, Array<{ value?: string }>>
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Parse "key = v1, v2, v3" lines into entries (first '=' splits key from values). */
export function parseEntries(v: unknown): MapOfSetsEntry[] {
  const lines = Array.isArray(v) ? v.map((x) => String(x)) : asString(v).split(/\n/)
  const out: MapOfSetsEntry[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const eq = line.indexOf('=')
    const key = (eq < 0 ? line : line.slice(0, eq)).trim()
    const valuePart = eq < 0 ? '' : line.slice(eq + 1)
    const values = [...new Set(valuePart.split(',').map((t) => t.trim()).filter((t) => t.length > 0))]
    out.push({ key, values })
  }
  return out
}

export function extractMapOfSetsSpecs(canvas: CanvasSnapshot): MapOfSetsSpec[] {
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
  const specs = extractMapOfSetsSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate map-of-sets "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!(ELEMENT_TYPES as readonly string[]).includes(spec.elementType)) {
      errors.push({ field: `${prefix}.elementType`, message: `Element type must be one of: ${ELEMENT_TYPES.join(', ')}`, code: 'invalid_element_type' })
    }

    const seenKeys = new Set<string>()
    spec.entries.forEach((e, ei) => {
      if (!e.key) errors.push({ field: `${prefix}.entries[${ei}]`, message: 'Each entry needs a key (key = value, value)', code: 'missing_key' })
      if (e.values.length === 0) errors.push({ field: `${prefix}.entries[${ei}]`, message: `Key "${e.key}" needs at least one value`, code: 'missing_values' })
      if (e.key && seenKeys.has(e.key.toLowerCase())) {
        errors.push({ field: `${prefix}.entries[${ei}]`, message: `Duplicate key "${e.key}" in this map-of-sets`, code: 'duplicate_key' })
      }
      if (e.key) seenKeys.add(e.key.toLowerCase())
    })

    if (spec.entries.length === 0) {
      warnings.push({ field: `${prefix}.entries`, message: 'This map-of-sets is empty', code: 'empty_map' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
