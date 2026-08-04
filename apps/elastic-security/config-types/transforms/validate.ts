import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Elasticsearch _transform API constraints ---------------------------------

export const MAX_TRANSFORM_ID_LENGTH = 255

/** Top-level keys the _update endpoint accepts — everything else (pivot/latest) is immutable after creation. */
export const MUTABLE_DEFINITION_KEYS = ['sync', 'frequency', 'settings', 'retention_policy'] as const

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface TransformSpec {
  sectionName: string
  /** Transform id — the logical identity carried in the PUT/GET/DELETE path. */
  transformId: string
  description?: string
  /** Whether the transform should be running (started) or stopped. */
  enabled: boolean
  sourceIndex: string[]
  /** Raw JSON-object string for source.query; absent = match_all. */
  sourceQueryJson?: string
  destIndex: string
  destPipeline?: string
  /** Raw JSON-object string with EXACTLY ONE of pivot/latest plus any mutable keys. Required. */
  definitionJson?: string
}

/** Shape of a transform's config returned by GET /_transform/{id} → `{ count, transforms: [...] }`. */
export interface LiveTransform {
  id?: string
  description?: string
  source?: { index?: string[]; query?: Record<string, unknown> }
  dest?: { index?: string; pipeline?: string }
  pivot?: Record<string, unknown>
  latest?: Record<string, unknown>
  sync?: Record<string, unknown>
  frequency?: string
  settings?: Record<string, unknown>
  retention_policy?: Record<string, unknown>
}

/** GET /_transform/{id} response envelope. */
export interface LiveTransformListResponse {
  count?: number
  transforms?: LiveTransform[]
}

/** A transform's running state, from GET /_transform/{id}/_stats. */
export type TransformState = 'started' | 'indexing' | 'stopping' | 'stopped' | 'aborting' | 'failed' | 'waiting'

export interface LiveTransformStats {
  id?: string
  state?: TransformState
}

export interface LiveTransformStatsResponse {
  transforms?: LiveTransformStats[]
}

/** Split a `tags` field (array, or comma/newline string) into trimmed, non-empty strings. */
export function splitList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
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

/** Strip the mutable keys, leaving only the immutable pivot/latest aggregation (plus anything else authored). */
export function stripMutableKeys(definition: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(definition)) {
    if (!(MUTABLE_DEFINITION_KEYS as readonly string[]).includes(key)) out[key] = value
  }
  return out
}

/** Keep only the mutable keys the _update endpoint accepts. */
export function pickMutableKeys(definition: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of MUTABLE_DEFINITION_KEYS) {
    if (key in definition) out[key] = definition[key]
  }
  return out
}

/** Each canvas section describes one transform. */
export function extractTransformSpecs(canvas: CanvasSnapshot): TransformSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const trimmed = (key: string): string | undefined =>
      typeof fields[key] === 'string' && (fields[key] as string).trim() ? (fields[key] as string).trim() : undefined

    return {
      sectionName: section.name,
      transformId: typeof fields.transformId === 'string' ? fields.transformId.trim() : '',
      description: trimmed('description'),
      enabled: fields.enabled !== false,
      sourceIndex: splitList(fields.sourceIndex),
      sourceQueryJson: trimmed('sourceQueryJson'),
      destIndex: typeof fields.destIndex === 'string' ? fields.destIndex.trim() : '',
      destPipeline: trimmed('destPipeline'),
      definitionJson: trimmed('definitionJson'),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate transform configurations against Elasticsearch _transform
 * constraints. Static rules only — NO network:
 *   - transformId, sourceIndex (>= 1) and destIndex are required
 *   - sourceQueryJson, when present, must parse to a JSON object
 *   - definitionJson is required, must parse to a JSON object, and must
 *     declare EXACTLY ONE of "pivot" or "latest" (Elasticsearch requires
 *     exactly one; a config with both or neither is rejected)
 *   - the transformId — a transform's logical identity — must be unique
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractTransformSpecs(ctx.canvas)
  const seenIds = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.transformId) {
      errors.push({ field: `${prefix}.transformId`, message: 'Transform ID is required', code: 'required' })
    } else if (spec.transformId.length > MAX_TRANSFORM_ID_LENGTH) {
      errors.push({
        field: `${prefix}.transformId`,
        message: `Transform ID must be ${MAX_TRANSFORM_ID_LENGTH} characters or fewer`,
        code: 'max_length',
      })
    }

    if (spec.sourceIndex.length === 0) {
      errors.push({ field: `${prefix}.sourceIndex`, message: 'At least one Source Index Pattern is required', code: 'required' })
    }

    if (!spec.destIndex) {
      errors.push({ field: `${prefix}.destIndex`, message: 'Destination Index is required', code: 'required' })
    }

    if (spec.sourceQueryJson && parseJsonObject(spec.sourceQueryJson) === null) {
      errors.push({
        field: `${prefix}.sourceQueryJson`,
        message: 'Source Query must be a valid JSON object — leave blank to match all documents',
        code: 'invalid_source_query',
      })
    }

    if (!spec.definitionJson) {
      errors.push({
        field: `${prefix}.definitionJson`,
        message: 'Definition is required — provide a JSON object with exactly one of "pivot" or "latest"',
        code: 'required',
      })
    } else {
      const parsed = parseJsonObject(spec.definitionJson)
      if (parsed === null) {
        errors.push({
          field: `${prefix}.definitionJson`,
          message: 'Definition must be a valid JSON object',
          code: 'invalid_definition',
        })
      } else {
        const hasPivot = 'pivot' in parsed
        const hasLatest = 'latest' in parsed
        if (hasPivot === hasLatest) {
          errors.push({
            field: `${prefix}.definitionJson`,
            message: hasPivot
              ? 'Definition must declare only ONE of "pivot" or "latest", not both'
              : 'Definition must declare exactly one of "pivot" or "latest"',
            code: 'invalid_aggregation',
          })
        }
      }
    }

    if (spec.transformId) {
      if (seenIds.has(spec.transformId)) {
        errors.push({
          field: `${prefix}.transformId`,
          message: `Duplicate transform "${spec.transformId}" — each transform id may only be declared once per canvas`,
          code: 'duplicate_transform',
        })
      }
      seenIds.add(spec.transformId)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
