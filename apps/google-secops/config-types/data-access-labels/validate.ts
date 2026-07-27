import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Google SecOps data access label constraints -----------------------------

/** dataAccessLabelId: starts with a letter, letters/digits/underscore/hyphen, max 63 (AIP-122). */
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/

export interface DataAccessLabelSpec {
  itemId?: string
  /** name = dataAccessLabelId — the immutable identity (also the label's display name). */
  name: string
  /** The label's definition: a UDM query over event data. */
  udmQuery: string
  description: string
}

/** A data access label as returned by the SecOps API. `name` is `{parent}/dataAccessLabels/{id}`. */
export interface LiveDataAccessLabel {
  name?: string
  displayName?: string
  udmQuery?: string
  description?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractDataAccessLabelSpecs(canvas: CanvasSnapshot): DataAccessLabelSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      udmQuery: asString(f.udmQuery),
      description: asString(f.description),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractDataAccessLabelSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (!ID_RE.test(spec.name)) {
        errors.push({ field: `${prefix}.name`, message: 'Name must start with a letter, contain only letters, digits, underscores and hyphens, and be at most 63 characters', code: 'invalid_name' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate data access label "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.udmQuery) {
      errors.push({ field: `${prefix}.udmQuery`, message: 'A UDM query is required — it defines which event data receives this label', code: 'required' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
