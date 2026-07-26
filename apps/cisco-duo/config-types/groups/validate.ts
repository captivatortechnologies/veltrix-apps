import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Cisco Duo group constraints ---------------------------------------------

export const MAX_NAME_LENGTH = 255
export const MAX_DESC_LENGTH = 255

export interface GroupSpec {
  itemId?: string
  /** name — the logical identity (Duo groups are addressed by id, so the app
   *  matches on name and stores the id for rename-safety). */
  name: string
  desc: string
}

/** A group as returned by GET /admin/v1/groups. */
export interface LiveGroup {
  group_id?: string
  name?: string
  desc?: string | null
  status?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractGroupSpecs(canvas: CanvasSnapshot): GroupSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => ({
    itemId: item.id,
    name: asString(item.fields?.name) || item.name,
    desc: asString(item.fields?.desc),
  }))
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractGroupSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`,
          code: 'too_long',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate group "${spec.name}" — each may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    if (spec.desc.length > MAX_DESC_LENGTH) {
      errors.push({
        field: `${prefix}.desc`,
        message: `Description must be ${MAX_DESC_LENGTH} characters or fewer`,
        code: 'too_long',
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
