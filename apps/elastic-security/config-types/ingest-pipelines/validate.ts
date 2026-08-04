import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Elasticsearch _ingest/pipeline API constraints ---------------------------

/** Pipeline id length cap (kept generous; ES itself is lenient here). */
export const MAX_PIPELINE_ID_LENGTH = 255

/** Ids beginning with `.` are the Elastic-managed / internal convention (e.g. `.fleet_globals-1`). */
export function isProtectedPipelineId(id: string): boolean {
  return id.startsWith('.')
}

/** Ids containing "@" commonly belong to a Fleet/Elastic Agent integration's managed pipeline chain. */
export function isIntegrationManagedId(id: string): boolean {
  return id.includes('@')
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface IngestPipelineSpec {
  sectionName: string
  /** Pipeline id — the logical identity carried in the PUT/GET/DELETE path. */
  id: string
  description?: string
  /** Raw JSON-array string of processor objects. Required; deploy re-parses it. */
  processorsJson?: string
  /** Raw JSON-array string of on_failure processor objects; absent = none. */
  onFailureJson?: string
  version?: number
  /** Raw JSON-object string of arbitrary metadata (the pipeline's `_meta`). */
  metaJson?: string
}

/** Shape of a pipeline returned by GET /_ingest/pipeline[/{id}] → `{ "<id>": { description, processors, on_failure, version, _meta } }`. */
export interface LiveIngestPipeline {
  description?: string
  processors?: unknown[]
  on_failure?: unknown[]
  version?: number
  _meta?: Record<string, unknown>
}

/** The GET /_ingest/pipeline response is a map keyed by pipeline id. */
export type LiveIngestPipelineResponse = Record<string, LiveIngestPipeline>

/** Parse a raw JSON string, returning the array or null when it is not a JSON array. */
export function parseJsonArray(raw: string): unknown[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  return Array.isArray(parsed) ? parsed : null
}

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

/** True when a live pipeline is flagged Elastic-managed via `_meta.managed: true`. */
export function isManagedPipeline(pipeline: LiveIngestPipeline): boolean {
  const meta = pipeline._meta
  return !!meta && typeof meta === 'object' && !Array.isArray(meta) && (meta as Record<string, unknown>).managed === true
}

/** Each canvas section describes one ingest pipeline. */
export function extractPipelineSpecs(canvas: CanvasSnapshot): IngestPipelineSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const trimmed = (key: string): string | undefined =>
      typeof fields[key] === 'string' && (fields[key] as string).trim() ? (fields[key] as string).trim() : undefined

    return {
      sectionName: section.name,
      id: typeof fields.id === 'string' ? fields.id.trim() : '',
      description: trimmed('description'),
      processorsJson: trimmed('processorsJson'),
      onFailureJson: trimmed('onFailureJson'),
      version: typeof fields.version === 'number' ? fields.version : undefined,
      metaJson: trimmed('metaJson'),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate ingest-pipeline configurations against Elasticsearch _ingest
 * constraints. Static rules only — NO network:
 *   - id is required, capped, and must NOT use the reserved `.` prefix; an "@"
 *     in the id is WARNED (commonly integration-managed)
 *   - processorsJson is required and must parse to a JSON ARRAY
 *   - onFailureJson / metaJson, when present, must parse to their expected shape
 *   - the id — a pipeline's logical identity — must be unique across the canvas
 *
 * The live-managed backstop (refusing any live pipeline with `_meta.managed:
 * true`) is enforced in deploy, where the current server state is available.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractPipelineSpecs(ctx.canvas)
  const seenIds = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.id) {
      errors.push({ field: `${prefix}.id`, message: 'Pipeline ID is required', code: 'required' })
    } else {
      if (spec.id.length > MAX_PIPELINE_ID_LENGTH) {
        errors.push({
          field: `${prefix}.id`,
          message: `Pipeline ID must be ${MAX_PIPELINE_ID_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      if (isProtectedPipelineId(spec.id)) {
        errors.push({
          field: `${prefix}.id`,
          message: `Pipeline id "${spec.id}" is reserved — ids starting with "." are Elastic-managed / internal and cannot be authored`,
          code: 'protected_pipeline',
        })
      } else if (isIntegrationManagedId(spec.id)) {
        warnings.push({
          field: `${prefix}.id`,
          message: `Pipeline id "${spec.id}" contains "@" — this commonly belongs to a Fleet/Elastic Agent integration's managed pipeline chain, which may overwrite it on package upgrade`,
          code: 'integration_managed',
        })
      }
    }

    if (!spec.processorsJson) {
      errors.push({
        field: `${prefix}.processorsJson`,
        message: 'Processors is required — provide a JSON array of processor objects, e.g. [{"set":{"field":"x","value":"y"}}]',
        code: 'required',
      })
    } else if (parseJsonArray(spec.processorsJson) === null) {
      errors.push({
        field: `${prefix}.processorsJson`,
        message: 'Processors must be a valid JSON array of processor objects',
        code: 'invalid_processors',
      })
    }

    if (spec.onFailureJson && parseJsonArray(spec.onFailureJson) === null) {
      errors.push({
        field: `${prefix}.onFailureJson`,
        message: 'On Failure must be a valid JSON array of processor objects — leave blank for none',
        code: 'invalid_on_failure',
      })
    }

    if (spec.metaJson && parseJsonObject(spec.metaJson) === null) {
      errors.push({
        field: `${prefix}.metaJson`,
        message: 'Meta must be a valid JSON object, e.g. {"managed_by":"veltrix"} — leave blank for none',
        code: 'invalid_meta',
      })
    }

    if (spec.id) {
      if (seenIds.has(spec.id)) {
        errors.push({
          field: `${prefix}.id`,
          message: `Duplicate pipeline "${spec.id}" — each pipeline id may only be declared once per canvas`,
          code: 'duplicate_pipeline',
        })
      }
      seenIds.add(spec.id)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
