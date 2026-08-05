import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- IBM QRadar tagged-field category constraints -----------------------------

export interface TaggedFieldCategorySpec {
  itemId?: string
  /** name — the category's natural identity (matched by name, rename-safe by id). */
  name: string
}

/** A tagged-field category as returned by GET /ariel/taggedfieldcategories. */
export interface LiveTaggedFieldCategory {
  id?: number
  name?: string
  uuid?: string
  creation_date?: number
  modified_date?: number
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractTaggedFieldCategorySpecs(canvas: CanvasSnapshot): TaggedFieldCategorySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractTaggedFieldCategorySpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > 255) {
        errors.push({ field: `${prefix}.name`, message: 'Name must be 255 characters or fewer', code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate tagged field category "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
