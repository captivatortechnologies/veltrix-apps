import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

export const ASSET_GROUP_TYPES = ['static', 'dynamic'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface AssetGroupSpec {
  sectionName: string
  name: string
  description: string
  type: string
  searchCriteriaJson: string
}

/** Shape of an asset group returned by GET /asset_groups. */
export interface LiveAssetGroup {
  id?: number
  name?: string
  description?: string
  type?: string
  searchCriteria?: unknown
}

/** The name natural key — an asset group's logical identity (name-keyed collection). */
export function assetGroupKey(spec: { name: string }): string {
  return spec.name.trim().toLowerCase()
}

/**
 * Parse a JSON object field. NON-UNION { value, error } (never a discriminated
 * union — the platform loader can't narrow those).
 */
export interface JsonParseResult {
  value: Record<string, unknown> | null
  error: string | null
}

export function parseJsonObject(raw: string | undefined): JsonParseResult {
  const text = (raw ?? '').trim()
  if (!text) return { value: {}, error: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { value: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: null, error: 'must be a JSON object' }
  }
  return { value: parsed as Record<string, unknown>, error: null }
}

/** Each canvas item describes one InsightVM asset group. */
export function extractAssetGroupSpecs(canvas: CanvasSnapshot): AssetGroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      type: typeof fields.type === 'string' ? fields.type.trim() : '',
      searchCriteriaJson: typeof fields.search_criteria_json === 'string' ? fields.search_criteria_json : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate asset group configurations: a name is required, the type is from the
 * supported set, a dynamic group requires a search-criteria JSON object, and the
 * name natural key is unique across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAssetGroupSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Asset group name is required', code: 'required' })
    }

    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'Asset group type is required', code: 'required' })
    } else if (!ASSET_GROUP_TYPES.includes(spec.type as (typeof ASSET_GROUP_TYPES)[number])) {
      errors.push({ field: `${prefix}.type`, message: `Unsupported asset group type "${spec.type}"`, code: 'invalid_type' })
    }

    // A dynamic asset group is defined by its search criteria — require and validate it.
    if (spec.type === 'dynamic') {
      if (!spec.searchCriteriaJson.trim()) {
        errors.push({
          field: `${prefix}.search_criteria_json`,
          message: 'Search criteria is required for a dynamic asset group',
          code: 'required',
        })
      } else {
        const parsed = parseJsonObject(spec.searchCriteriaJson)
        if (parsed.error) {
          errors.push({ field: `${prefix}.search_criteria_json`, message: `Search criteria ${parsed.error}`, code: 'invalid_json' })
        }
      }
    }

    if (spec.name) {
      const key = assetGroupKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate asset group "${spec.name}" — each name may only be declared once`,
          code: 'duplicate_asset_group',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
