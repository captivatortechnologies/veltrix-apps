import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ZIA Network Application Group constraints -------------------------------

/** ZIA caps a network application group name and description at 255 characters. */
export const MAX_GROUP_NAME_LENGTH = 255
export const MAX_GROUP_DESCRIPTION_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface NetworkAppGroupSpec {
  sectionName: string
  /** The network application group name — its logical identity (list + match). */
  name: string
  description?: string
  /** Predefined ZIA network-application ids that belong to the group (e.g. APNS). */
  networkApplications: string[]
}

/** Shape of a network application group returned by GET /networkApplicationGroups. */
export interface LiveNetworkAppGroup {
  id?: number
  name?: string
  description?: string
  networkApplications?: string[]
}

/** Split a textarea value into trimmed, non-blank lines. */
export function splitLines(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** Each canvas item describes one ZIA network application group. */
export function extractNetworkAppGroupSpecs(canvas: CanvasSnapshot): NetworkAppGroupSpec[] {
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
      networkApplications: splitLines(fields.network_applications),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate network application group configurations against ZIA constraints: a
 * name is required and capped at 255 chars, the description is capped at 255
 * chars, at least one member network application id must be declared, and the
 * name — a group's logical identity — must be unique across the canvas (matched
 * case-insensitively, since ZIA rejects groups differing only in case).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractNetworkAppGroupSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({
        field: `${prefix}.name`,
        message: 'Network application group name is required',
        code: 'required',
      })
    } else {
      if (spec.name.length > MAX_GROUP_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Network application group name must be ${MAX_GROUP_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate network application group "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_network_app_group',
        })
      }
      seen.add(key)
    }

    if (spec.description && spec.description.length > MAX_GROUP_DESCRIPTION_LENGTH) {
      errors.push({
        field: `${prefix}.description`,
        message: `Description must be ${MAX_GROUP_DESCRIPTION_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    if (spec.networkApplications.length === 0) {
      errors.push({
        field: `${prefix}.network_applications`,
        message: 'At least one network application id is required (e.g. APNS)',
        code: 'required',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
