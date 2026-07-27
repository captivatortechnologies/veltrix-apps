import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import type { LiveEntity } from '../../lib/entityAdapter'

// --- Cloud Security custom compliance framework constraints ------------------

export const MAX_FRAMEWORK_NAME_LENGTH = 255

/** One declared framework section — realized in Falcon via its controls. */
export interface FrameworkSection {
  name: string
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface FrameworkSpec {
  sectionName: string
  name: string
  description?: string
  version?: string
  sections: FrameworkSection[]
  /** Raw sections JSON, retained so validate can report a parse error. */
  sectionsRaw?: string
}

/**
 * Live custom compliance framework as returned by
 * GET /cloud-policies/entities/compliance/frameworks/v1. The identifier is
 * `uuid` (not `id`) and `version`/`authority` are assigned by Falcon.
 */
export interface LiveFramework extends LiveEntity {
  uuid?: string
  name?: string
  description?: string
  version?: string
  authority?: string
  active?: boolean
  /** Last modifier recorded by Falcon — used for drift attribution when present. */
  modified_by?: string
  modified_timestamp?: string
  modified_on?: string
}

/** Each canvas section describes one custom compliance framework. */
export function extractFrameworkSpecs(canvas: CanvasSnapshot): FrameworkSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const sectionsRaw =
      typeof fields.sections === 'string' && fields.sections.trim()
        ? fields.sections.trim()
        : undefined

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description:
        typeof fields.description === 'string' && fields.description.trim()
          ? fields.description.trim()
          : undefined,
      version:
        typeof fields.version === 'string' && fields.version.trim()
          ? fields.version.trim()
          : undefined,
      sections: parseSections(sectionsRaw).sections,
      sectionsRaw,
    }
  })
}

/**
 * Parse and structurally validate the sections JSON. Each entry must carry a
 * non-empty `name`; section names must be unique within the framework.
 */
export function parseSections(raw: string | undefined): {
  sections: FrameworkSection[]
  errors: string[]
} {
  if (!raw) return { sections: [], errors: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      sections: [],
      errors: [`Sections is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`],
    }
  }

  if (!Array.isArray(parsed)) {
    return { sections: [], errors: ['Sections must be a JSON array of section objects'] }
  }

  const sections: FrameworkSection[] = []
  const errors: string[] = []
  const seen = new Set<string>()

  parsed.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`Section #${index + 1}: must be an object like {"name": "Access Control"}`)
      return
    }
    const name = typeof (entry as Record<string, unknown>).name === 'string'
      ? ((entry as Record<string, unknown>).name as string).trim()
      : ''
    if (!name) {
      errors.push(`Section #${index + 1}: "name" must be a non-empty string`)
      return
    }
    if (seen.has(name.toLowerCase())) {
      errors.push(`Section "${name}": declared more than once`)
      return
    }
    seen.add(name.toLowerCase())
    sections.push({ name })
  })

  return { sections, errors }
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate custom compliance framework configurations against Cloud Security
 * Policies API constraints: a unique framework name and a well-formed sections
 * list.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractFrameworkSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name (framework identity)
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Framework name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_FRAMEWORK_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Framework name must be ${MAX_FRAMEWORK_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate framework "${spec.name}" — each framework may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seen.add(key)
    }

    // sections JSON
    const { sections: parsedSections, errors: sectionErrors } = parseSections(spec.sectionsRaw)
    for (const message of sectionErrors) {
      errors.push({ field: `${prefix}.sections`, message, code: 'invalid_sections' })
    }
    if (sectionErrors.length === 0 && parsedSections.length === 0 && spec.sectionsRaw) {
      warnings.push({
        field: `${prefix}.sections`,
        message: 'Sections JSON is an empty array — the framework will have no sections',
        code: 'no_sections',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
