import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Tenable Assets Attributes API constraints -------------------------------

/**
 * A custom asset-attribute name may contain only letters, numbers, spaces,
 * underscores and hyphens. This is the field's logical identity.
 */
export const ATTRIBUTE_NAME_PATTERN = /^[A-Za-z0-9_ -]+$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface AttributeSpec {
  sectionName: string
  /** Attribute field name — the logical identity. */
  name: string
  /** Optional description of the attribute field. */
  description?: string
}

/** Shape of an attribute definition returned by GET /api/v3/assets/attributes. */
export interface LiveAttribute {
  /** Tenable-assigned id (usually a uuid string); addresses update/delete. */
  id?: string | number
  name?: string
  description?: string
}

/** Each canvas section describes one custom asset-attribute FIELD definition. */
export function extractAttributeSpecs(canvas: CanvasSnapshot): AttributeSpec[] {
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
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate custom asset-attribute definitions against the Tenable Assets
 * Attributes API constraints: a name is required and may contain only letters,
 * numbers, spaces, underscores and hyphens, and the name — an attribute's
 * logical identity — must be unique across the canvas.
 *
 * This is static validation only; it performs no network calls. Note the config
 * type manages field DEFINITIONS, not per-asset attribute values.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAttributeSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required and constrained to a safe character set
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Attribute name is required', code: 'required' })
    } else if (!ATTRIBUTE_NAME_PATTERN.test(spec.name)) {
      errors.push({
        field: `${prefix}.name`,
        message:
          'Attribute name may contain only letters, numbers, spaces, underscores and hyphens',
        code: 'invalid_name',
      })
    }

    // name is the attribute's logical identity — dedupe on it. Matched exactly
    // (not case-folded): Tenable stores the name as a literal string, so two
    // names differing only in case are distinct attribute definitions.
    if (spec.name) {
      if (seenNames.has(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate attribute "${spec.name}" — each attribute name may only be declared once per canvas`,
          code: 'duplicate_attribute',
        })
      }
      seenNames.add(spec.name)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
