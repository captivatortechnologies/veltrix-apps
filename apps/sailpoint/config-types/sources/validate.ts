import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC Source constraints ----------------------------------------

export const MAX_NAME_LENGTH = 128

export interface SourceSpec {
  itemId?: string
  /** name — the logical identity (unique per tenant); the id is stored for rename-safety. */
  name: string
  description: string
  ownerId: string
  /** connector script name, e.g. "active-directory-direct". */
  connectorName: string
  /** id of the managed cluster hosting a VA connector (required for on-prem connectors). */
  clusterId: string
  /** raw JSON text for the connector-specific `connectorAttributes` object. */
  connectorAttributesRaw: string
  /** account delete threshold percentage (0 = unset). */
  deleteThreshold: number
}

/** A source as returned by GET /v3/sources. */
export interface LiveSource {
  id?: string
  name?: string
  description?: string | null
  owner?: { id?: string }
  connectorName?: string
  cluster?: { id?: string } | null
  connectorAttributes?: Record<string, unknown>
  deleteThreshold?: number
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return 0
}

/** Parse a JSON-object blob field. Empty ⇒ {}. Must be a plain object. */
export function parseJsonObject(
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
    return { ok: false, error: 'must be a JSON object' }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

export function extractSourceSpecs(canvas: CanvasSnapshot): SourceSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      ownerId: asString(f.ownerId),
      connectorName: asString(f.connectorName),
      clusterId: asString(f.clusterId),
      connectorAttributesRaw:
        typeof f.connectorAttributes === 'string'
          ? f.connectorAttributes.trim()
          : f.connectorAttributes && typeof f.connectorAttributes === 'object'
            ? JSON.stringify(f.connectorAttributes)
            : '',
      deleteThreshold: asNumber(f.deleteThreshold),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractSourceSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate source "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.ownerId) {
      errors.push({ field: `${prefix}.ownerId`, message: 'An owner Identity id is required', code: 'required' })
    }
    if (!spec.connectorName) {
      errors.push({ field: `${prefix}.connectorName`, message: 'A connector name is required (e.g. "active-directory-direct")', code: 'required' })
    }

    const parsed = parseJsonObject(spec.connectorAttributesRaw)
    if (!parsed.ok) {
      errors.push({ field: `${prefix}.connectorAttributes`, message: `Connector attributes must be a JSON object: ${parsed.error}`, code: 'invalid_attributes' })
    }
    if (spec.deleteThreshold < 0 || spec.deleteThreshold > 100 || !Number.isInteger(spec.deleteThreshold)) {
      errors.push({ field: `${prefix}.deleteThreshold`, message: 'Delete threshold must be a whole number between 0 and 100', code: 'invalid_number' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
