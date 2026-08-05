import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface SonarQuerySpec {
  sectionName: string
  name: string
  /** The criteria.filters array, authored as JSON. */
  criteriaJson: string
}

/**
 * Shape of a Sonar query returned by GET /sonar_queries. The index signature
 * preserves any other field the console attaches so rollback can PUT the prior
 * document back verbatim.
 */
export interface LiveSonarQuery {
  id?: number
  name?: string
  criteria?: { filters?: unknown[] }
  [key: string]: unknown
}

/** The name natural key — a Sonar query's logical identity. */
export function sonarQueryKey(spec: { name: string }): string {
  return spec.name.trim().toLowerCase()
}

/**
 * Parse the criteria filters JSON. NON-UNION { value, error } (never a
 * discriminated union — the platform loader can't narrow those).
 */
export interface FiltersParseResult {
  value: Record<string, unknown>[] | null
  error: string | null
}

export function parseFilters(raw: string | undefined): FiltersParseResult {
  const text = (raw ?? '').trim()
  if (!text) return { value: null, error: 'is required' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { value: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (!Array.isArray(parsed)) {
    return { value: null, error: 'must be a JSON array of filter objects' }
  }
  if (parsed.length === 0) {
    return { value: null, error: 'must contain at least one filter' }
  }
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i]
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { value: null, error: `filter ${i + 1} must be an object` }
    }
  }
  return { value: parsed as Record<string, unknown>[], error: null }
}

/** Each canvas item describes one InsightVM Sonar query. */
export function extractSonarQuerySpecs(canvas: CanvasSnapshot): SonarQuerySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      criteriaJson: typeof fields.criteria_json === 'string' ? fields.criteria_json : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Sonar query configurations: a name and criteria filters are
 * required, the criteria JSON must parse to a non-empty array of filter
 * objects, and the name (the natural key) is unique across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractSonarQuerySpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Sonar query name is required', code: 'required' })
    }

    const parsed = parseFilters(spec.criteriaJson)
    if (parsed.error) {
      errors.push({
        field: `${prefix}.criteria_json`,
        message: `Criteria ${parsed.error}`,
        code: spec.criteriaJson.trim() ? 'invalid_criteria' : 'required',
      })
    }

    if (spec.name) {
      const key = sonarQueryKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate Sonar query "${spec.name}" — each name may only be declared once`,
          code: 'duplicate_sonar_query',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
