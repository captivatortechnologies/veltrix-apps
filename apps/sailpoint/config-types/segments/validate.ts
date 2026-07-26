import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- SailPoint ISC Segment constraints ---------------------------------------

export const MAX_NAME_LENGTH = 128

export interface SegmentSpec {
  itemId?: string
  /** name — the logical identity (ISC segments are id-addressed with no name
   *  filter, so the app lists all and matches by name, storing the id). */
  name: string
  description: string
  active: boolean
}

/** A segment as returned by GET /segments/v1. */
export interface LiveSegment {
  id?: string
  name?: string
  description?: string | null
  active?: boolean
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

export function extractSegmentSpecs(canvas: CanvasSnapshot): SegmentSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => ({
    itemId: item.id,
    name: asString(item.fields?.name) || item.name,
    description: asString(item.fields?.description),
    active: asBool(item.fields?.active),
  }))
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractSegmentSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate segment "${spec.name}" — each may only be declared once per canvas`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
