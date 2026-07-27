import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC Identity Attribute constraints ----------------------------
// Name-keyed (the technical name is the path key). The app owns only CUSTOM
// attributes — standard/system attributes cannot be modified or deleted.

export interface IdentityAttributeSpec {
  itemId?: string
  /** technical attribute name (the path key). */
  name: string
  displayName: string
  type: string
  multi: boolean
  searchable: boolean
  /** raw JSON for the `sources` array (attribute source/transform mappings). */
  sourcesRaw: string
}

/** An identity attribute as returned by GET /beta/identity-attributes. */
export interface LiveIdentityAttribute {
  name?: string
  displayName?: string
  standard?: boolean
  system?: boolean
  type?: string
  multi?: boolean
  searchable?: boolean
  sources?: unknown[]
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
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

export function extractIdentityAttributeSpecs(canvas: CanvasSnapshot): IdentityAttributeSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      displayName: asString(f.displayName),
      type: asString(f.type) || 'string',
      multi: asBool(f.multi),
      searchable: asBool(f.searchable),
      sourcesRaw:
        typeof f.sources === 'string'
          ? f.sources.trim()
          : Array.isArray(f.sources)
            ? JSON.stringify(f.sources)
            : '',
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractIdentityAttributeSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate identity attribute "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    const parsed = parseJsonArray(spec.sourcesRaw)
    if (!parsed.ok) {
      errors.push({ field: `${prefix}.sources`, message: `Sources must be a JSON array: ${parsed.error}`, code: 'invalid_sources' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
