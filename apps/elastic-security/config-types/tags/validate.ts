import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Kibana Tags API constraints ----------------------------------------------

export const MAX_TAG_NAME_LENGTH = 256
export const MAX_TAG_DESCRIPTION_LENGTH = 2048

/** A tag id is URL-friendly: lowercase letters, digits, hyphen and underscore. */
export const TAG_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

/** Tag color must be a 3- or 6-digit hex value. */
export const TAG_COLOR_PATTERN = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface TagSpec {
  sectionName: string
  /** Tag id — the logical identity carried in the PUT/GET/DELETE path. */
  id: string
  name: string
  color: string
  description?: string
}

/** Shape of a tag returned by GET /api/tags/{id} (and echoed by PUT). */
export interface LiveTag {
  id?: string
  name?: string
  color?: string
  description?: string
}

/** Each canvas section describes one tag. */
export function extractTagSpecs(canvas: CanvasSnapshot): TagSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const description =
      typeof fields.description === 'string' && fields.description.trim() ? fields.description.trim() : undefined

    return {
      sectionName: section.name,
      id: typeof fields.id === 'string' ? fields.id.trim() : '',
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      color: typeof fields.color === 'string' ? fields.color.trim() : '',
      description,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate tag configurations against the Kibana Tags API constraints. Static
 * rules only — NO network: id / name / color are required (id URL-friendly,
 * color a hex value), description is capped, and the id — a tag's logical
 * identity — must be unique across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractTagSpecs(ctx.canvas)
  const seenIds = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.id) {
      errors.push({ field: `${prefix}.id`, message: 'Tag ID is required', code: 'required' })
    } else if (!TAG_ID_PATTERN.test(spec.id)) {
      errors.push({
        field: `${prefix}.id`,
        message: 'Tag id must be URL-friendly: lowercase letters, digits, hyphens and underscores only, starting with a letter or digit',
        code: 'invalid_id',
      })
    }

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Tag name is required', code: 'required' })
    } else if (spec.name.length > MAX_TAG_NAME_LENGTH) {
      errors.push({
        field: `${prefix}.name`,
        message: `Tag name must be ${MAX_TAG_NAME_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    if (!spec.color) {
      errors.push({ field: `${prefix}.color`, message: 'Tag color is required', code: 'required' })
    } else if (!TAG_COLOR_PATTERN.test(spec.color)) {
      errors.push({
        field: `${prefix}.color`,
        message: 'Tag color must be a hex value such as #0B64DD (6-digit) or #07C (3-digit)',
        code: 'invalid_color',
      })
    }

    if (spec.description && spec.description.length > MAX_TAG_DESCRIPTION_LENGTH) {
      errors.push({
        field: `${prefix}.description`,
        message: `Description must be ${MAX_TAG_DESCRIPTION_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    if (spec.id) {
      const key = spec.id.toLowerCase()
      if (seenIds.has(key)) {
        errors.push({
          field: `${prefix}.id`,
          message: `Duplicate tag "${spec.id}" — each tag id may only be declared once per canvas`,
          code: 'duplicate_tag',
        })
      }
      seenIds.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
