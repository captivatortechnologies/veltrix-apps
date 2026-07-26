import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Netskope device classification tag constraints --------------------------

export const MAX_NAME_LENGTH = 80

export interface TagSpec {
  itemId?: string
  /** name — the logical identity (tags are id-addressed with no name filter). */
  name: string
  description: string
}

/** A tag as returned by GET /deviceclassification/tags. */
export interface LiveTag {
  id?: number | string
  name?: string
  description?: string | null
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractTagSpecs(canvas: CanvasSnapshot): TagSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => ({
    itemId: item.id,
    name: asString(item.fields?.name) || item.name,
    description: asString(item.fields?.description),
  }))
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractTagSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate tag "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
