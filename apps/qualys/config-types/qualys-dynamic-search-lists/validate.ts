import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { parseFlatScalarObject } from '../lib/qualysJson'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface DynamicListSpec {
  sectionName: string
  title: string
  global: boolean
  comments: string
  criteriaJson: string
}

/** Shape of a dynamic search list parsed from a list response <DYNAMIC_LIST> block. */
export interface LiveDynamicList {
  id: string
  title: string
  global: boolean
  comments: string
}

export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === '1' || value === 1) return true
  if (value === 'false' || value === '0' || value === 0) return false
  return fallback
}

/** The title natural key — a dynamic list's logical identity (title-keyed collection). */
export function dynamicListKey(spec: { title: string }): string {
  return spec.title.trim().toLowerCase()
}

/** Each canvas item describes one Qualys dynamic search list. */
export function extractDynamicListSpecs(canvas: CanvasSnapshot): DynamicListSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      title: typeof fields.title === 'string' ? fields.title.trim() : '',
      global: readBool(fields.global, false),
      comments: typeof fields.comments === 'string' ? fields.comments.trim() : '',
      criteriaJson: typeof fields.criteria_json === 'string' ? fields.criteria_json : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate dynamic search list configurations: a title is required, unique and
 * within Qualys' 256-character limit; the criteria JSON must parse to a non-empty
 * flat object of scalar parameters.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractDynamicListSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.title) {
      errors.push({ field: `${prefix}.title`, message: 'Search list title is required', code: 'required' })
    } else if (spec.title.length > 256) {
      errors.push({
        field: `${prefix}.title`,
        message: 'Search list title must be 256 characters or fewer',
        code: 'too_long',
      })
    }

    const parsed = parseFlatScalarObject(spec.criteriaJson)
    if (parsed.error) {
      errors.push({
        field: `${prefix}.criteria_json`,
        message: `Criteria ${parsed.error}`,
        code: spec.criteriaJson.trim() ? 'invalid_json' : 'required',
      })
    } else if (parsed.value && Object.keys(parsed.value).length === 0) {
      errors.push({
        field: `${prefix}.criteria_json`,
        message: 'At least one search criterion is required',
        code: 'required',
      })
    }

    if (spec.title) {
      const key = dynamicListKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.title`,
          message: `Duplicate search list "${spec.title}" — each title may only be declared once`,
          code: 'duplicate_dynamic_list',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
