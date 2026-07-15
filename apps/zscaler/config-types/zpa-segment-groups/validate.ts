import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface SegmentGroupSpec {
  sectionName: string
  /** The segment group name — its logical identity (list + match). */
  name: string
  description?: string
  enabled: boolean
}

/** Shape of a segment group returned by GET /segmentGroup. */
export interface LiveSegmentGroup {
  id?: string
  name?: string
  description?: string
  enabled?: boolean
}

/** Read a boolean field, defaulting to `fallback` when unset/non-boolean. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** Each canvas item describes one ZPA segment group. */
export function extractSegmentGroupSpecs(canvas: CanvasSnapshot): SegmentGroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : undefined
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description,
      enabled: readBool(fields.enabled, true),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate segment group configurations: a name is required and unique across
 * the canvas (matched case-insensitively — ZPA rejects groups differing only in
 * case).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractSegmentGroupSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Segment group name is required', code: 'required' })
      continue
    }
    if (spec.name.length > 255) {
      errors.push({
        field: `${prefix}.name`,
        message: 'Segment group name must be 255 characters or fewer',
        code: 'max_length',
      })
    }
    const key = spec.name.toLowerCase()
    if (seen.has(key)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate segment group "${spec.name}" — each name may only be declared once per canvas`,
        code: 'duplicate_segment_group',
      })
    }
    seen.add(key)
  }

  return { valid: errors.length === 0, errors, warnings }
}
