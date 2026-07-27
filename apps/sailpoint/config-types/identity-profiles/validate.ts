import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC Identity Profile constraints ------------------------------

export const MAX_NAME_LENGTH = 128

export interface IdentityProfileSpec {
  itemId?: string
  /** name — the logical identity (unique per tenant); the id is stored for rename-safety. */
  name: string
  description: string
  ownerId: string
  priority: number
  /** id of the authoritative Source this profile builds identities from (immutable). */
  authoritativeSourceId: string
  /** raw JSON for the `identityAttributeConfig` object (attribute transforms). */
  attributeConfigRaw: string
}

/** An identity profile as returned by GET /v3/identity-profiles. */
export interface LiveIdentityProfile {
  id?: string
  name?: string
  description?: string | null
  owner?: { id?: string } | null
  priority?: number
  authoritativeSource?: { id?: string }
  identityAttributeConfig?: Record<string, unknown>
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return 0
}

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

export function extractIdentityProfileSpecs(canvas: CanvasSnapshot): IdentityProfileSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      ownerId: asString(f.ownerId),
      priority: asNumber(f.priority),
      authoritativeSourceId: asString(f.authoritativeSourceId),
      attributeConfigRaw:
        typeof f.attributeConfig === 'string'
          ? f.attributeConfig.trim()
          : f.attributeConfig && typeof f.attributeConfig === 'object'
            ? JSON.stringify(f.attributeConfig)
            : '',
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractIdentityProfileSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate identity profile "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.authoritativeSourceId) {
      errors.push({ field: `${prefix}.authoritativeSourceId`, message: 'An authoritative source id is required', code: 'required' })
    }
    if (spec.priority < 0 || !Number.isInteger(spec.priority)) {
      errors.push({ field: `${prefix}.priority`, message: 'Priority must be a non-negative whole number', code: 'invalid_number' })
    }

    const parsed = parseJsonObject(spec.attributeConfigRaw)
    if (!parsed.ok) {
      errors.push({ field: `${prefix}.attributeConfig`, message: `Attribute config must be a JSON object: ${parsed.error}`, code: 'invalid_attributes' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
