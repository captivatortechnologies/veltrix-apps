import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Netskope custom URL category constraints --------------------------------
// Backed by /api/v2/profiles/customcategories. Categories group URL lists,
// destination profiles and predefined Netskope categories under one name for
// use in Real-time Protection and other policies.

export const MAX_NAME_LENGTH = 100
export const MAX_DESCRIPTION_LENGTH = 200
/** included_predefined_categories are numeric string ids (e.g. "500" for
 *  Financial_Services) per Netskope's predefined category list — not names. */
const NUMERIC_ID_RE = /^\d+$/

export interface CustomCategorySpec {
  itemId?: string
  /** name — the logical identity (categories are id-addressed; the app matches
   *  on name and stores the id for rename-safety). */
  name: string
  description: string
  /** Numeric string ids of predefined Netskope categories to include. */
  includedPredefinedCategories: string[]
  /** URL list NAMES; resolved to url-list ids at deploy. */
  includedUrlLists: string[]
  /** URL list NAMES; resolved to url-list ids at deploy. */
  excludedUrlLists: string[]
  /** Destination profile NAMES; resolved to profile ids at deploy. */
  includedDestinationProfiles: string[]
  /** Destination profile NAMES; resolved to profile ids at deploy. */
  excludedDestinationProfiles: string[]
}

/** A custom category as returned by GET /api/v2/profiles/customcategories. */
export interface LiveCustomCategory {
  id?: string
  name?: string
  description?: string
  included_predefined_categories?: string[]
  included_url_lists?: string[]
  excluded_url_lists?: string[]
  included_destination_profiles?: string[]
  excluded_destination_profiles?: string[]
  status?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Split a textarea/array value into trimmed, non-empty entries. */
export function splitEntries(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((t) => t.length > 0)
  return asString(v)
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

export function liveCustomCategoryId(l: LiveCustomCategory): string | undefined {
  return l.id === undefined || l.id === null ? undefined : String(l.id)
}

export function extractCustomCategorySpecs(canvas: CanvasSnapshot): CustomCategorySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      includedPredefinedCategories: splitEntries(f.included_predefined_categories),
      includedUrlLists: splitEntries(f.included_url_lists),
      excludedUrlLists: splitEntries(f.excluded_url_lists),
      includedDestinationProfiles: splitEntries(f.included_destination_profiles),
      excludedDestinationProfiles: splitEntries(f.excluded_destination_profiles),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractCustomCategorySpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate custom category "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (spec.description.length > MAX_DESCRIPTION_LENGTH) {
      errors.push({ field: `${prefix}.description`, message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`, code: 'too_long' })
    }

    spec.includedPredefinedCategories.forEach((id, j) => {
      if (!NUMERIC_ID_RE.test(id)) {
        errors.push({
          field: `${prefix}.included_predefined_categories[${j}]`,
          message: `"${id}" is not a valid predefined category id — Netskope predefined categories are referenced by numeric id (e.g. "500"), not by name`,
          code: 'invalid_predefined_category_id',
        })
      }
    })

    const total =
      spec.includedPredefinedCategories.length +
      spec.includedUrlLists.length +
      spec.excludedUrlLists.length +
      spec.includedDestinationProfiles.length +
      spec.excludedDestinationProfiles.length
    if (total === 0) {
      warnings.push({ field: `${prefix}.included_url_lists`, message: 'No included/excluded lists, profiles or predefined categories — this category will match nothing', code: 'empty_category' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
