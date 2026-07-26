import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface SecurityFrameworkSpec {
  sectionName: string
  name: string
  description: string
  enabled: boolean
  /** Raw categories JSON as typed by the user (validated separately). */
  categoriesText: string
  /** Parsed categories value — undefined when blank, may be malformed shape. */
  categories: unknown
}

/** A framework as returned by the `securityFrameworks` list query. */
export interface LiveSecurityFramework {
  id?: string
  name?: string
  enabled?: boolean | null
  builtin?: boolean | null
}

/** A sub-category as returned by the single-framework read query. */
export interface FullSubCategory {
  id?: string
  title?: string
  description?: string
  resolutionRecommendation?: string
}

/** A category as returned by the single-framework read query. */
export interface FullCategory {
  id?: string
  name?: string
  description?: string
  subCategories?: FullSubCategory[]
}

/** A framework as returned by the single-framework read query (full managed state). */
export interface FullSecurityFramework {
  id?: string
  name?: string
  description?: string
  enabled?: boolean | null
  builtin?: boolean | null
  categories?: FullCategory[]
}

/** The framework's logical identity: its name (case-insensitive, trimmed). */
export function frameworkKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Parse a checkbox/boolean-ish canvas value, falling back when absent. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** Try to parse JSON text; empty text is treated as absent (ok, undefined value). */
export function tryParseJson(text: string): { value: unknown; ok: boolean } {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return { value: undefined, ok: true }
  try {
    return { value: JSON.parse(trimmed), ok: true }
  } catch {
    return { value: undefined, ok: false }
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Each canvas item describes one Wiz security framework. */
export function extractSecurityFrameworkSpecs(canvas: CanvasSnapshot): SecurityFrameworkSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const categoriesText = typeof fields.categories === 'string' ? fields.categories.trim() : ''
    const parsed = tryParseJson(categoriesText)
    return {
      sectionName: section.name,
      name: str(fields.name),
      description: str(fields.description),
      enabled: readBool(fields.enabled, true),
      categoriesText,
      categories: parsed.ok ? parsed.value : undefined,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Wiz security-framework configurations: name is required and unique
 * across the canvas (case-insensitive); categories must be a non-empty JSON
 * array where each category has a name and at least one sub-category, and each
 * sub-category has a title and a description (Wiz nullifies a sub-category whose
 * description is omitted).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractSecurityFrameworkSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Security framework name is required', code: 'required' })
    }

    validateCategories(spec, prefix, errors)

    if (spec.name) {
      const key = frameworkKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate security framework "${spec.name}" — each name may only be declared once`,
          code: 'duplicate_framework',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

/** Validate the categories JSON structure for one framework spec. */
function validateCategories(spec: SecurityFrameworkSpec, prefix: string, errors: ValidationResult['errors']): void {
  const field = `${prefix}.categories`

  if (!spec.categoriesText) {
    errors.push({ field, message: 'At least one category is required', code: 'required' })
    return
  }
  if (spec.categories === undefined) {
    errors.push({ field, message: 'Categories must be valid JSON', code: 'invalid_json' })
    return
  }
  if (!Array.isArray(spec.categories) || spec.categories.length === 0) {
    errors.push({ field, message: 'Categories must be a non-empty JSON array', code: 'invalid_categories' })
    return
  }

  spec.categories.forEach((cat, ci) => {
    const cLabel = `${field}[${ci}]`
    if (typeof cat !== 'object' || cat === null || Array.isArray(cat)) {
      errors.push({ field: cLabel, message: 'Each category must be an object', code: 'invalid_categories' })
      return
    }
    const category = cat as Record<string, unknown>
    if (!str(category.name)) {
      errors.push({ field: `${cLabel}.name`, message: 'Each category needs a name', code: 'required' })
    }
    const subs = category.subCategories
    if (!Array.isArray(subs) || subs.length === 0) {
      errors.push({
        field: `${cLabel}.subCategories`,
        message: 'Each category needs at least one sub-category',
        code: 'invalid_categories',
      })
      return
    }
    subs.forEach((sub, si) => {
      const sLabel = `${cLabel}.subCategories[${si}]`
      if (typeof sub !== 'object' || sub === null || Array.isArray(sub)) {
        errors.push({ field: sLabel, message: 'Each sub-category must be an object', code: 'invalid_categories' })
        return
      }
      const subCategory = sub as Record<string, unknown>
      if (!str(subCategory.title)) {
        errors.push({ field: `${sLabel}.title`, message: 'Each sub-category needs a title', code: 'required' })
      }
      if (!str(subCategory.description)) {
        errors.push({
          field: `${sLabel}.description`,
          message: 'Each sub-category needs a description (Wiz clears it if omitted)',
          code: 'required',
        })
      }
    })
  })
}
