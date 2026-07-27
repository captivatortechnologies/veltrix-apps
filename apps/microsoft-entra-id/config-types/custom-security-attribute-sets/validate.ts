import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Entra custom-security-attribute-set constraints -------------------------
//
// Attribute sets cannot be renamed or deleted, so this type preserves them
// (upsert-by-id) and never issues a delete.

export const MAX_ID_LENGTH = 32
export const MAX_DESCRIPTION_LENGTH = 128
const ID_RE = /^[A-Za-z0-9_]+$/

export interface AttributeSetSpec {
  itemId?: string
  /** id — caller-supplied, immutable, the logical identity and Graph resource id. */
  id: string
  description: string
  /** null means "no limit". */
  maxAttributesPerSet: number | null
}

/** A custom security attribute set as returned by Graph. */
export interface LiveAttributeSet {
  id?: string
  description?: string | null
  maxAttributesPerSet?: number | null
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function asNumberOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return null
}

export function extractAttributeSetSpecs(canvas: CanvasSnapshot): AttributeSetSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      id: asString(f.id),
      description: asString(f.description),
      maxAttributesPerSet: asNumberOrNull(f.maxAttributesPerSet),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAttributeSetSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.id) {
      errors.push({ field: `${prefix}.id`, message: 'Attribute set id is required', code: 'required' })
    } else {
      if (spec.id.length > MAX_ID_LENGTH) {
        errors.push({
          field: `${prefix}.id`,
          message: `Attribute set id must be ${MAX_ID_LENGTH} characters or fewer`,
          code: 'too_long',
        })
      }
      if (!ID_RE.test(spec.id)) {
        errors.push({
          field: `${prefix}.id`,
          message: 'Attribute set id may contain only letters, digits and underscores (no spaces)',
          code: 'invalid_id',
        })
      }
      const key = spec.id.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.id`,
          message: `Duplicate attribute set "${spec.id}" — each may only be declared once per canvas`,
          code: 'duplicate_id',
        })
      }
      seen.add(key)
    }

    if (spec.description.length > MAX_DESCRIPTION_LENGTH) {
      errors.push({
        field: `${prefix}.description`,
        message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`,
        code: 'too_long',
      })
    }

    if (spec.maxAttributesPerSet !== null && (!Number.isInteger(spec.maxAttributesPerSet) || spec.maxAttributesPerSet <= 0)) {
      errors.push({
        field: `${prefix}.maxAttributesPerSet`,
        message: 'Max attributes per set must be a positive whole number (or blank for no limit)',
        code: 'invalid_max',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
