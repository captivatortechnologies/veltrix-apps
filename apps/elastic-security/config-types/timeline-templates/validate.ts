import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Kibana Security Timeline API constraints (/api/timeline) ---------------

export const MAX_TITLE_LENGTH = 500
export const MAX_DESCRIPTION_LENGTH = 2000

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface TimelineTemplateSpec {
  sectionName: string
  /** A caller-chosen, stable UUID/string — the identity GET /api/timeline matches templates on. */
  templateTimelineId: string
  title: string
  description?: string
  /** Raw JSON-object string with the rest of the timeline body (dataProviders, kqlQuery, filters, columns, ...). */
  definitionJson?: string
}

/** The fields of a live timeline this app authors/diffs (subset of Kibana's TimelineResponse). */
export interface LiveTimeline {
  savedObjectId?: string
  version?: string
  title?: string
  description?: string
  templateTimelineId?: string
  templateTimelineVersion?: number
  timelineType?: string
  status?: string
  columns?: unknown[]
  dataProviders?: unknown[]
  kqlQuery?: Record<string, unknown>
  kqlMode?: string
  filters?: unknown[]
  sort?: unknown
  dateRange?: Record<string, unknown>
  indexNames?: string[]
  eqlOptions?: Record<string, unknown>
  excludedRowRendererIds?: string[]
  savedQueryId?: string
  dataViewId?: string
  created?: number
  createdBy?: string
  updated?: number
  updatedBy?: string
}

/** The definition keys folded into `definitionJson` (everything a template carries besides identity/title/description). */
export const DEFINITION_KEYS = [
  'columns',
  'dataProviders',
  'kqlQuery',
  'kqlMode',
  'filters',
  'sort',
  'dateRange',
  'indexNames',
  'eqlOptions',
  'excludedRowRendererIds',
  'savedQueryId',
  'dataViewId',
] as const

/** Parse a raw JSON string, returning the object or null when it is not a JSON object. */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
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

/** Project a live timeline down to just its DEFINITION_KEYS (excluding identity/title/description/server bookkeeping). */
export function definitionOf(live: LiveTimeline): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of DEFINITION_KEYS) {
    const value = (live as Record<string, unknown>)[key]
    if (value !== undefined && value !== null) out[key] = value
  }
  return out
}

/** Each canvas section describes one timeline template. */
export function extractTemplateSpecs(canvas: CanvasSnapshot): TimelineTemplateSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const trimmed = (key: string): string | undefined =>
      typeof fields[key] === 'string' && (fields[key] as string).trim() ? (fields[key] as string).trim() : undefined

    return {
      sectionName: section.name,
      templateTimelineId: typeof fields.templateTimelineId === 'string' ? fields.templateTimelineId.trim() : '',
      title: typeof fields.title === 'string' ? fields.title.trim() : '',
      description: trimmed('description'),
      definitionJson: trimmed('definitionJson'),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate timeline-template configurations against the Kibana Security
 * Timeline API. Static rules only — NO network:
 *   - templateTimelineId + title are required; templateTimelineId is the
 *     logical identity and must be unique across the canvas
 *   - title / description are capped
 *   - definitionJson, when present, must parse to a JSON object
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractTemplateSpecs(ctx.canvas)
  const seenIds = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.templateTimelineId) {
      errors.push({ field: `${prefix}.templateTimelineId`, message: 'Template Timeline ID is required', code: 'required' })
    }

    if (!spec.title) {
      errors.push({ field: `${prefix}.title`, message: 'Title is required', code: 'required' })
    } else if (spec.title.length > MAX_TITLE_LENGTH) {
      errors.push({ field: `${prefix}.title`, message: `Title must be ${MAX_TITLE_LENGTH} characters or fewer`, code: 'max_length' })
    }

    if (spec.description && spec.description.length > MAX_DESCRIPTION_LENGTH) {
      errors.push({
        field: `${prefix}.description`,
        message: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    if (spec.definitionJson && parseJsonObject(spec.definitionJson) === null) {
      errors.push({
        field: `${prefix}.definitionJson`,
        message: 'Definition must be a valid JSON object — leave blank for an empty template',
        code: 'invalid_definition',
      })
    }

    if (spec.templateTimelineId) {
      if (seenIds.has(spec.templateTimelineId)) {
        errors.push({
          field: `${prefix}.templateTimelineId`,
          message: `Duplicate template "${spec.templateTimelineId}" — each templateTimelineId may only be declared once per canvas`,
          code: 'duplicate_template',
        })
      }
      seenIds.add(spec.templateTimelineId)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
