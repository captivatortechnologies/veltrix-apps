import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- ZIA URL Categories constraints ------------------------------------------
//
// SPECIAL type: this manages CUSTOM URL categories only. ZIA identifies a custom
// URL category by its `configuredName` (the user-facing name), and — unlike the
// numeric-id ZIA objects — its `id` is a STRING (custom = "CUSTOM_xx"; predefined
// = the enum name). Predefined categories are read-only.

/** ZIA caps a custom URL category configuredName at 31 characters. */
export const MAX_CONFIGURED_NAME_LENGTH = 31
/** ZIA allows a longer free-text description on a URL category. */
export const MAX_DESCRIPTION_LENGTH = 255

/** Valid URL category kinds. */
export const URL_CATEGORY_TYPES = ['URL_CATEGORY', 'TLD_CATEGORY'] as const
export type UrlCategoryType = (typeof URL_CATEGORY_TYPES)[number]

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface UrlCategorySpec {
  sectionName: string
  /** The custom URL category configuredName — its logical identity (list + match). */
  configuredName: string
  description?: string
  /** Parent super-category (defaults to USER_DEFINED). */
  superCategory: string
  /** URL_CATEGORY (default) or TLD_CATEGORY. */
  type: string
  /** URLs the category matches (one per line in the canvas). */
  urls: string[]
  /** Optional keywords the category matches. */
  keywords: string[]
}

/**
 * Shape of a URL category returned by GET /urlCategories.
 *
 * NOTE the id is a STRING here (custom = "CUSTOM_xx"; predefined = the enum
 * name), which is the key deviation from the numeric-id ZIA config types.
 * `customCategory` is true only for author-managed categories — predefined ones
 * (customCategory !== true) are read-only.
 */
export interface LiveUrlCategory {
  id?: string
  configuredName?: string
  customCategory?: boolean
  superCategory?: string
  type?: string
  urls?: string[]
  keywords?: string[]
  description?: string
}

/** Split a textarea value into trimmed, non-blank lines. */
export function splitLines(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/** Each canvas item describes one ZIA custom URL category. */
export function extractUrlCategorySpecs(canvas: CanvasSnapshot): UrlCategorySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : undefined
    // super_category is REQUIRED, so read it raw (no default) — validate enforces
    // presence, and deploy backfills USER_DEFINED defensively.
    const superCategory =
      typeof fields.super_category === 'string' ? fields.super_category.trim() : ''
    // type is OPTIONAL with a default, so backfill it here.
    const type =
      typeof fields.type === 'string' && fields.type.trim() ? fields.type.trim() : 'URL_CATEGORY'
    return {
      sectionName: section.name,
      configuredName: typeof fields.configured_name === 'string' ? fields.configured_name.trim() : '',
      description,
      superCategory,
      type,
      urls: splitLines(fields.urls),
      keywords: splitLines(fields.keywords),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate custom URL category configurations against ZIA constraints: a
 * configuredName is required, capped at 31 chars, and unique across the canvas
 * (matched case-insensitively, since ZIA rejects categories differing only in
 * case). A super-category is required, and at least one URL must be declared.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractUrlCategorySpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.configuredName) {
      errors.push({
        field: `${prefix}.configured_name`,
        message: 'URL category name is required',
        code: 'required',
      })
    } else {
      if (spec.configuredName.length > MAX_CONFIGURED_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.configured_name`,
          message: `URL category name must be ${MAX_CONFIGURED_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.configuredName.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.configured_name`,
          message: `Duplicate URL category "${spec.configuredName}" — each name may only be declared once per canvas`,
          code: 'duplicate_url_category',
        })
      }
      seen.add(key)
    }

    if (!spec.superCategory) {
      errors.push({
        field: `${prefix}.super_category`,
        message: 'Super-category is required',
        code: 'required',
      })
    }

    if (spec.description && spec.description.length > MAX_DESCRIPTION_LENGTH) {
      errors.push({
        field: `${prefix}.description`,
        message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    if (spec.urls.length === 0) {
      errors.push({
        field: `${prefix}.urls`,
        message: 'At least one URL is required for a custom URL category',
        code: 'urls_required',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
