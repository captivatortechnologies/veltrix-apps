import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Google SecOps findings refinement (rule exclusion) constraints ----------

/** The only user-selectable refinement type — the rest is UNSPECIFIED. */
export const REFINEMENT_TYPE = 'DETECTION_EXCLUSION'
/** OutcomeFilter.operator enum. */
export const OUTCOME_OPERATORS = ['EQUAL', 'CONTAINS', 'MATCHES_REGEX', 'MATCHES_CIDR'] as const

export interface OutcomeFilter {
  field: string
  operator: string
  value: string
}

export interface FindingsRefinementSpec {
  itemId?: string
  /** displayName = the refinement's identity we own (the id is server-assigned). */
  displayName: string
  /** The UDM query selecting the findings to exclude. */
  query: string
  outcomeFiltersRaw: string
  /** Parsed outcome filters, or null when the JSON is malformed. */
  outcomeFilters: OutcomeFilter[] | null
}

/** A findings refinement as returned by the SecOps API. `name` is `{parent}/findingsRefinements/{id}`. */
export interface LiveFindingsRefinement {
  name?: string
  displayName?: string
  type?: string
  query?: string
  outcomeFilters?: OutcomeFilter[]
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Parse the optional outcomeFilters JSON blob into an array, or null when malformed. */
export function parseOutcomeFilters(raw: string): OutcomeFilter[] | null {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    if (!Array.isArray(v)) return null
    return v.map((f) => ({
      field: typeof f?.field === 'string' ? f.field : '',
      operator: typeof f?.operator === 'string' ? f.operator : '',
      value: typeof f?.value === 'string' ? f.value : '',
    }))
  } catch {
    return null
  }
}

export function extractFindingsRefinementSpecs(canvas: CanvasSnapshot): FindingsRefinementSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const outcomeFiltersRaw = asString(f.outcomeFilters)
    return {
      itemId: item.id,
      displayName: asString(f.displayName) || item.name,
      query: asString(f.query),
      outcomeFiltersRaw,
      outcomeFilters: parseOutcomeFilters(outcomeFiltersRaw),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractFindingsRefinementSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.displayName) {
      errors.push({ field: `${prefix}.displayName`, message: 'Display name is required', code: 'required' })
    } else {
      const key = spec.displayName.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.displayName`, message: `Duplicate findings refinement "${spec.displayName}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.query) {
      errors.push({ field: `${prefix}.query`, message: 'A UDM query is required — it selects the findings this refinement excludes', code: 'required' })
    }

    if (spec.outcomeFiltersRaw && !spec.outcomeFilters) {
      errors.push({ field: `${prefix}.outcomeFilters`, message: 'Outcome filters must be a JSON array of { field, operator, value }', code: 'invalid_json' })
    } else if (spec.outcomeFilters) {
      spec.outcomeFilters.forEach((f, fi) => {
        if (!f.field || !f.operator) {
          errors.push({ field: `${prefix}.outcomeFilters[${fi}]`, message: 'Each outcome filter needs a field and an operator', code: 'invalid_filter' })
        } else if (!(OUTCOME_OPERATORS as readonly string[]).includes(f.operator)) {
          errors.push({ field: `${prefix}.outcomeFilters[${fi}]`, message: `Operator must be one of: ${OUTCOME_OPERATORS.join(', ')}`, code: 'invalid_operator' })
        }
      })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
