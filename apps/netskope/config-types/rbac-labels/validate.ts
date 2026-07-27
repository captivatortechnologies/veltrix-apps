import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Netskope RBAC label constraints -----------------------------------------

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

export interface LabelSpec {
  itemId?: string
  /** name — the logical identity (labels are id-addressed with no name filter). */
  name: string
  /** optional #RRGGBB color. */
  color: string
}

/** A label as returned by GET /api/v2/rbac/labels. */
export interface LiveLabel {
  id?: string
  name?: string
  color?: string | null
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractLabelSpecs(canvas: CanvasSnapshot): LabelSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => ({
    itemId: item.id,
    name: asString(item.fields?.name) || item.name,
    color: asString(item.fields?.color),
  }))
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractLabelSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate label "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (spec.color && !HEX_COLOR_RE.test(spec.color)) {
      errors.push({ field: `${prefix}.color`, message: 'Color must be a #RRGGBB hex value', code: 'invalid_color' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
