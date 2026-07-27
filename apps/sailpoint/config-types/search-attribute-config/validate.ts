import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC Search Attribute Configuration constraints -----------------
// Name-keyed: the attribute name is the path key (no separate id).

export interface SearchAttributeSpec {
  itemId?: string
  /** the extended search attribute name (the path key). */
  name: string
  displayName: string
  /** map of sourceId → source attribute name. */
  applicationAttributes: Record<string, string>
}

/** A search attribute config as returned by GET /v3/accounts/search-attribute-config. */
export interface LiveSearchAttribute {
  name?: string
  displayName?: string
  applicationAttributes?: Record<string, string>
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Read a keyvalue field into a string→string map. */
export function toStringMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const key = k.trim()
    if (key) out[key] = typeof val === 'string' ? val : String(val ?? '')
  }
  return out
}

export function extractSearchAttributeSpecs(canvas: CanvasSnapshot): SearchAttributeSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      displayName: asString(f.displayName),
      applicationAttributes: toStringMap(f.applicationAttributes),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractSearchAttributeSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate search attribute "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (spec.name && Object.keys(spec.applicationAttributes).length === 0) {
      warnings.push({ field: `${prefix}.applicationAttributes`, message: `Search attribute "${spec.name}" maps no source attributes — it will index nothing`, code: 'no_mappings' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
