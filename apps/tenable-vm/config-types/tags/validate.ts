import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Tenable Tags API constraints ---------------------------------------------

/** A tag value's human name is capped at 50 chars and may not contain a comma. */
export const MAX_TAG_VALUE_LENGTH = 50

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface TagSpec {
  sectionName: string
  /** Category name — the left half of a category:value tag. */
  category: string
  /** Value — the right half; the UUID Tenable assigns belongs to this. */
  value: string
  description?: string
  /** category_description — only used by Tenable when the category is auto-created. */
  categoryDescription?: string
  /** Raw JSON asset-filter string; absent/blank = a static tag. */
  filters?: string
}

/** Shape of a tag value returned by GET /tags/values. */
export interface LiveTag {
  uuid?: string
  category_uuid?: string
  category_name?: string
  value?: string
  description?: string
  filters?: unknown
}

/** Each canvas section describes one Tenable tag (a category:value pair). */
export function extractTagSpecs(canvas: CanvasSnapshot): TagSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : undefined
    const categoryDescription =
      typeof fields.category_description === 'string' && fields.category_description.trim()
        ? fields.category_description.trim()
        : undefined
    const filters =
      typeof fields.filters === 'string' && fields.filters.trim()
        ? fields.filters.trim()
        : undefined

    return {
      sectionName: section.name,
      category: typeof fields.category === 'string' ? fields.category.trim() : '',
      value: typeof fields.value === 'string' ? fields.value.trim() : '',
      description,
      categoryDescription,
      filters,
    }
  })
}

/**
 * Parse a raw asset-filter string, returning the object or null when the string
 * is not a JSON object (a JSON array or primitive counts as invalid too).
 * Shared by validate (to reject bad input) and deploy (to build the API body).
 */
export function parseFilterObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  return null
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate tag configurations against Tenable Tags API constraints:
 * a category and value are required, the value is capped at 50 chars and may
 * not contain a comma, any asset filter must be a JSON object, and the
 * (category, value) pair — a tag's logical identity — must be unique.
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
  const seenPairs = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // category — the left half of the tag; Tenable auto-creates it if new
    if (!spec.category) {
      errors.push({ field: `${prefix}.category`, message: 'Tag category is required', code: 'required' })
    }

    // value — required, <= 50 chars, no commas
    if (!spec.value) {
      errors.push({ field: `${prefix}.value`, message: 'Tag value is required', code: 'required' })
    } else {
      if (spec.value.length > MAX_TAG_VALUE_LENGTH) {
        errors.push({
          field: `${prefix}.value`,
          message: `Tag value must be ${MAX_TAG_VALUE_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      if (spec.value.includes(',')) {
        errors.push({
          field: `${prefix}.value`,
          message: 'Tag value must not contain a comma',
          code: 'invalid_value',
        })
      }
    }

    // filters — optional; when present it must parse as a JSON object
    if (spec.filters && parseFilterObject(spec.filters) === null) {
      errors.push({
        field: `${prefix}.filters`,
        message:
          'Asset filter must be a valid JSON object, e.g. {"asset":{"and":[…]}} — leave blank for a static tag',
        code: 'invalid_filters',
      })
    }

    // (category, value) pair is the tag's logical identity — dedupe on it.
    // Matched exactly (not case-folded): Tenable stores these as literal
    // strings, so two values differing only in case are distinct tags. A
    // JSON-array key keeps the two halves unambiguously separated.
    if (spec.category && spec.value) {
      const key = JSON.stringify([spec.category, spec.value])
      if (seenPairs.has(key)) {
        errors.push({
          field: `${prefix}.value`,
          message: `Duplicate tag "${spec.category}:${spec.value}" — each category/value pair may only be declared once per canvas`,
          code: 'duplicate_tag',
        })
      }
      seenPairs.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
