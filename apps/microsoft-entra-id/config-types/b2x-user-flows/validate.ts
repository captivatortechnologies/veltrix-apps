import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra b2xIdentityUserFlow constraints -----------------------------------
//
// Flows are create/delete only (no PATCH). The supplied id is auto-prefixed to
// B2X_1_<id> by Graph, so the resulting id is used as the identity.

const BASE_ID_RE = /^[A-Za-z0-9]+$/

export interface B2xUserFlowSpec {
  itemId?: string
  /** Caller-supplied base id (becomes B2X_1_<id>). */
  id: string
  userFlowTypeVersion: number
  /** identityProvider ids or display names (e.g. "Facebook-OAUTH") — resolved at deploy time. */
  identityProviders: string[]
  /** identityUserFlowAttribute ids or display names — resolved at deploy time. */
  attributes: string[]
}

/** A b2x user flow as returned by Graph (id is already prefixed). */
export interface LiveB2xUserFlow {
  id?: string
  userFlowType?: string
  userFlowTypeVersion?: number
}

/** The Graph resource id after the B2X_1_ prefix is applied. */
export function resultingId(baseId: string): string {
  return `B2X_1_${baseId}`
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asNumber(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return fallback
}

/** Coerce a multiselect (array) or a delimited string into trimmed tokens. */
function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((t) => t.length > 0)
  return asString(v)
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

export function extractB2xUserFlowSpecs(canvas: CanvasSnapshot): B2xUserFlowSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      id: asString(f.id),
      userFlowTypeVersion: asNumber(f.userFlowTypeVersion, 1),
      identityProviders: asStringArray(f.identityProviders),
      attributes: asStringArray(f.attributes),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractB2xUserFlowSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.id) {
      errors.push({ field: `${prefix}.id`, message: 'Flow id is required', code: 'required' })
    } else {
      if (!BASE_ID_RE.test(spec.id)) {
        errors.push({
          field: `${prefix}.id`,
          message: 'Flow id may contain only letters and digits (it is prefixed with B2X_1_)',
          code: 'invalid_id',
        })
      }
      const key = spec.id.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.id`,
          message: `Duplicate flow id "${spec.id}" — each may only be declared once per canvas`,
          code: 'duplicate_id',
        })
      }
      seen.add(key)
    }

    if (!Number.isFinite(spec.userFlowTypeVersion) || spec.userFlowTypeVersion <= 0) {
      errors.push({
        field: `${prefix}.userFlowTypeVersion`,
        message: 'User flow type version must be a positive number (typically 1)',
        code: 'invalid_version',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
