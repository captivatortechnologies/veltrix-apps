import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra token-lifetime-policy constraints ---------------------------------

export const MAX_DISPLAY_NAME_LENGTH = 256
/** The expected root key of a token lifetime policy definition object. */
export const DEFINITION_ROOT_KEY = 'TokenLifetimePolicy'

export interface TokenLifetimeSpec {
  itemId?: string
  /** displayName — the logical identity live policies are matched on. */
  name: string
  /** The raw definition JSON text (a single JSON object as a string). */
  definition: string
  isOrganizationDefault: boolean
}

/** A token lifetime policy as returned by Graph. */
export interface LiveTokenLifetimePolicy {
  id?: string
  displayName?: string
  definition?: string[]
  isOrganizationDefault?: boolean
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

/** Parse a JSON string into a plain object, or null when it isn't a JSON object. */
export function parseDefinitionObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

/** Recursively sort object keys so equal objects stringify identically; array
 *  order is preserved (it is significant). */
function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortValue((v as Record<string, unknown>)[k])
    }
    return out
  }
  return v
}

/** Canonical form of a definition string for key-order-insensitive comparison. */
export function canonicalDefinition(text: string): string | null {
  const obj = parseDefinitionObject(text)
  return obj ? JSON.stringify(sortValue(obj)) : null
}

export function extractTokenLifetimeSpecs(canvas: CanvasSnapshot): TokenLifetimeSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      definition: asString(f.definition),
      isOrganizationDefault: asBool(f.isOrganizationDefault),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractTokenLifetimeSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_DISPLAY_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer`,
          code: 'too_long',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate token lifetime policy "${spec.name}" — each may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // definition — required, valid JSON object, expected root key
    if (!spec.definition) {
      errors.push({ field: `${prefix}.definition`, message: 'Definition is required', code: 'required' })
    } else {
      const obj = parseDefinitionObject(spec.definition)
      if (!obj) {
        errors.push({
          field: `${prefix}.definition`,
          message: 'Definition must be a valid JSON object',
          code: 'invalid_json',
        })
      } else if (!(DEFINITION_ROOT_KEY in obj)) {
        warnings.push({
          field: `${prefix}.definition`,
          message: `Definition is usually a JSON object with a "${DEFINITION_ROOT_KEY}" root key`,
          code: 'unexpected_definition',
        })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
