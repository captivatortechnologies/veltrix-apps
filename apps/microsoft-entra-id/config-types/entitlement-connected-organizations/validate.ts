import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra entitlement-management connected-organization constraints ---------
//
// Sponsors (internal/external) are not managed by this type.

export const MAX_DISPLAY_NAME_LENGTH = 256
export const ORG_STATES = new Set(['configured', 'proposed'])

export interface ConnectedOrgSpec {
  itemId?: string
  /** displayName — the logical identity live organizations are matched on. */
  name: string
  description: string
  state: string
  /** Raw JSON text: an array of identitySource objects (@odata.type discriminated). */
  identitySources: string
}

/** A connected organization as returned by Graph. */
export interface LiveConnectedOrg {
  id?: string
  displayName?: string
  description?: string | null
  state?: string
  identitySources?: unknown[]
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function parseArray(text: string): unknown[] | null {
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortValue((v as Record<string, unknown>)[k])
    return out
  }
  return v
}

export function canonical(v: unknown): string {
  return JSON.stringify(sortValue(v ?? []))
}

export function extractConnectedOrgSpecs(canvas: CanvasSnapshot): ConnectedOrgSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      state: asString(f.state) || 'configured',
      identitySources: asString(f.identitySources),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractConnectedOrgSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_DISPLAY_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate connected organization "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!ORG_STATES.has(spec.state)) {
      errors.push({ field: `${prefix}.state`, message: `State must be one of ${[...ORG_STATES].join(', ')}`, code: 'invalid_state' })
    }

    if (spec.identitySources && parseArray(spec.identitySources) === null) {
      errors.push({ field: `${prefix}.identitySources`, message: 'Identity sources must be a valid JSON array', code: 'invalid_json' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
