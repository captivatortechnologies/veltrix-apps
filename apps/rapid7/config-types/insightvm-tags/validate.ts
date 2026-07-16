import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

export const TAG_TYPES = ['custom', 'criticality', 'location', 'owner'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface TagSpec {
  sectionName: string
  name: string
  type: string
  color?: string
  riskModifier?: number
  searchCriteriaJson: string
}

/** Shape of a tag returned by GET /tags. */
export interface LiveTag {
  id?: number
  name?: string
  type?: string
  color?: string
  riskModifier?: number
  source?: string
  searchCriteria?: unknown
}

/** The (name, type) natural key — a tag's logical identity. */
export function tagKey(spec: { name: string; type: string }): string {
  return JSON.stringify([spec.name.toLowerCase(), spec.type.toLowerCase()])
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

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

/** Each canvas item describes one InsightVM tag. */
export function extractTagSpecs(canvas: CanvasSnapshot): TagSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const color = typeof fields.color === 'string' && fields.color.trim() ? fields.color.trim() : undefined
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      type: typeof fields.type === 'string' ? fields.type.trim() : '',
      color,
      riskModifier: readNumber(fields.risk_modifier),
      searchCriteriaJson: typeof fields.search_criteria_json === 'string' ? fields.search_criteria_json : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate tag configurations: a name and type are required, the type is from the
 * supported set, the search criteria (when present) is a JSON object, and the
 * (name, type) natural key is unique across the canvas.
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
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Tag name is required', code: 'required' })
    }
    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'Tag type is required', code: 'required' })
    } else if (!TAG_TYPES.includes(spec.type as (typeof TAG_TYPES)[number])) {
      errors.push({ field: `${prefix}.type`, message: `Unsupported tag type "${spec.type}"`, code: 'invalid_type' })
    }
    if (spec.searchCriteriaJson.trim()) {
      const parsed = parseJsonObject(spec.searchCriteriaJson)
      if (parsed.error) {
        errors.push({ field: `${prefix}.search_criteria_json`, message: `Search criteria ${parsed.error}`, code: 'invalid_json' })
      }
    }

    if (spec.name && spec.type) {
      const key = tagKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate tag "${spec.name}" (${spec.type}) — each (name, type) may only be declared once`,
          code: 'duplicate_tag',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
