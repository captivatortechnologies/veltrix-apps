import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { readOptionalString, readString, readStringArray } from '../../lib/fields'

// --- XSOAR list constraints ---------------------------------------------------

/** The list content types XSOAR supports (the "type" of a list). */
export const LIST_TYPES = ['plain_text', 'JSON', 'markdown', 'HTML', 'CSS'] as const
export type ListType = (typeof LIST_TYPES)[number]

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ListSpec {
  sectionName: string
  /** The list name — its identity in XSOAR (a list's id equals its name). */
  name: string
  type: ListType
  data: string
  tags: string[]
  commitMessage?: string
}

/** Shape of a list returned by GET /lists. */
export interface LiveList {
  id?: string
  name?: string
  data?: string
  type?: string
  version?: number
  locked?: boolean
  tags?: string[]
}

/** Coerce a raw list-type value to a supported ListType (defaults to plain_text). */
export function toListType(value: unknown): ListType {
  const v = readString(value)
  return (LIST_TYPES as readonly string[]).includes(v) ? (v as ListType) : 'plain_text'
}

/** Each canvas item describes one XSOAR list. */
export function extractListSpecs(canvas: CanvasSnapshot): ListSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: readString(fields.name),
      type: toListType(fields.listType),
      data: typeof fields.data === 'string' ? fields.data : '',
      tags: readStringArray(fields.tags),
      commitMessage: readOptionalString(fields.commitMessage),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate XSOAR list configurations: a name is required and must be unique
 * across the canvas (a list's identity), the type must be one XSOAR supports,
 * and a list declared as JSON must contain valid JSON.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractListSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'List name is required', code: 'required' })
      continue
    }

    if (seen.has(spec.name)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate list "${spec.name}" — each list name may only be declared once`,
        code: 'duplicate_list',
      })
    }
    seen.add(spec.name)

    if (spec.type === 'JSON' && spec.data.trim()) {
      try {
        JSON.parse(spec.data)
      } catch {
        errors.push({
          field: `${prefix}.data`,
          message: `List "${spec.name}" is typed JSON but its data is not valid JSON`,
          code: 'invalid_json',
        })
      }
    }

    if (!spec.data.trim()) {
      warnings.push({
        field: `${prefix}.data`,
        message: `List "${spec.name}" has no data — it will be created empty`,
        code: 'empty_data',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
