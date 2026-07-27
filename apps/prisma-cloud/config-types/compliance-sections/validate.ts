import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Prisma Cloud custom compliance section constraints ----------------------

export const MAX_SECTION_ID_LENGTH = 255
export const MAX_DESC_LENGTH = 2000

export interface SectionSpec {
  itemId?: string
  /** The parent custom standard's name — resolved to a complianceId at deploy. */
  standardName: string
  /** The parent requirement's requirementId (short code) within that standard. */
  requirementId: string
  /** sectionId — the short code that is the section's identity within a requirement. */
  sectionId: string
  description: string
  viewOrder?: number
}

/** A section as returned by GET /compliance/{requirementId}/section. */
export interface LiveSection {
  id?: string
  sectionId?: string
  description?: string | null
  viewOrder?: number
  label?: string
  systemDefault?: boolean
  associatedPolicyIds?: string[]
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

export function extractSectionSpecs(canvas: CanvasSnapshot): SectionSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      standardName: asString(f.standardName),
      requirementId: asString(f.requirementId),
      sectionId: asString(f.sectionId) || item.name,
      description: asString(f.description),
      viewOrder: asNumber(f.viewOrder),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractSectionSpecs(ctx.canvas)
  const seen = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.standardName) {
      errors.push({ field: `${prefix}.standardName`, message: 'Parent standard name is required', code: 'required' })
    }

    if (!spec.requirementId) {
      errors.push({ field: `${prefix}.requirementId`, message: 'Parent requirement ID is required', code: 'required' })
    }

    if (!spec.sectionId) {
      errors.push({ field: `${prefix}.sectionId`, message: 'Section ID is required', code: 'required' })
    } else if (spec.sectionId.length > MAX_SECTION_ID_LENGTH) {
      errors.push({ field: `${prefix}.sectionId`, message: `Section ID must be ${MAX_SECTION_ID_LENGTH} characters or fewer`, code: 'too_long' })
    }

    if (spec.description.length > MAX_DESC_LENGTH) {
      errors.push({ field: `${prefix}.description`, message: `Description must be ${MAX_DESC_LENGTH} characters or fewer`, code: 'too_long' })
    }

    if (spec.viewOrder !== undefined && spec.viewOrder < 0) {
      errors.push({ field: `${prefix}.viewOrder`, message: 'View order must be zero or greater', code: 'invalid_view_order' })
    }

    // Identity is (standard, requirement, section) — unique per canvas.
    if (spec.standardName && spec.requirementId && spec.sectionId) {
      const key = `${spec.standardName.toLowerCase()} ${spec.requirementId.toLowerCase()} ${spec.sectionId.toLowerCase()}`
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.sectionId`, message: `Duplicate section "${spec.sectionId}" in requirement "${spec.requirementId}"`, code: 'duplicate_section' })
      }
      seen.add(key)
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
