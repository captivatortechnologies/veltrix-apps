import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Elasticsearch _ml/anomaly_detectors + _ml/datafeeds API constraints -----

export const MAX_JOB_ID_LENGTH = 255

/** The datafeed id Kibana's own ML UI derives by default when one isn't supplied. */
export function defaultDatafeedId(jobId: string): string {
  return `datafeed-${jobId}`
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface MlJobSpec {
  sectionName: string
  /** Job id — the logical identity carried in the PUT/GET/DELETE path. */
  jobId: string
  /** Datafeed id; defaults to `datafeed-<jobId>` when left blank. */
  datafeedId: string
  description?: string
  groups: string[]
  /** Whether the job should be opened + its datafeed started, or closed + stopped. */
  enabled: boolean
  /** Raw JSON-object string. Required. IMMUTABLE after creation. */
  analysisConfigJson?: string
  /** Raw JSON-object string. Required. IMMUTABLE after creation. */
  dataDescriptionJson?: string
  resultsIndexName?: string
  /** Raw JSON-object string; mutable via job _update. */
  analysisLimitsJson?: string
  /** Raw JSON-object string; mutable via job _update. */
  modelPlotConfigJson?: string
  /** Raw JSON-object string; catch-all mutable job settings, merged in. */
  jobAdvancedJson?: string
  datafeedIndices: string[]
  /** Raw JSON-object string for datafeed.query; absent = match_all. */
  datafeedQueryJson?: string
  /** Raw JSON-object string; catch-all datafeed settings, merged in. */
  datafeedAdvancedJson?: string
}

/** Shape of a job's config returned by GET /_ml/anomaly_detectors/{id} → `{ count, jobs: [...] }`. */
export interface LiveMlJob {
  job_id?: string
  description?: string
  groups?: string[]
  analysis_config?: Record<string, unknown>
  data_description?: Record<string, unknown>
  analysis_limits?: Record<string, unknown>
  model_plot_config?: Record<string, unknown>
  results_index_name?: string
  custom_settings?: Record<string, unknown>
  categorization_filters?: string[]
  renormalization_window_days?: number
  results_retention_days?: number
  model_snapshot_retention_days?: number
  background_persist_interval?: string
  allow_lazy_open?: boolean
  daily_model_snapshot_retention_after_days?: number
}

export interface LiveMlJobListResponse {
  count?: number
  jobs?: LiveMlJob[]
}

export type MlJobState = 'opened' | 'closed' | 'opening' | 'closing' | 'failed'
export interface LiveMlJobStatsResponse {
  jobs?: Array<{ job_id?: string; state?: MlJobState }>
}

/** Shape of a datafeed's config returned by GET /_ml/datafeeds/{id} → `{ count, datafeeds: [...] }`. */
export interface LiveMlDatafeed {
  datafeed_id?: string
  job_id?: string
  indices?: string[]
  query?: Record<string, unknown>
  frequency?: string
  scroll_size?: number
  aggregations?: Record<string, unknown>
  runtime_mappings?: Record<string, unknown>
  chunking_config?: Record<string, unknown>
}

export interface LiveMlDatafeedListResponse {
  count?: number
  datafeeds?: LiveMlDatafeed[]
}

export type MlDatafeedState = 'started' | 'stopped' | 'starting' | 'stopping'
export interface LiveMlDatafeedStatsResponse {
  datafeeds?: Array<{ datafeed_id?: string; state?: MlDatafeedState }>
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

/** Each canvas section describes one ML job (+ its datafeed). */
export function extractJobSpecs(canvas: CanvasSnapshot): MlJobSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const trimmed = (key: string): string | undefined =>
      typeof fields[key] === 'string' && (fields[key] as string).trim() ? (fields[key] as string).trim() : undefined

    const jobId = typeof fields.jobId === 'string' ? fields.jobId.trim() : ''
    const datafeedId = trimmed('datafeedId') ?? (jobId ? defaultDatafeedId(jobId) : '')

    return {
      sectionName: section.name,
      jobId,
      datafeedId,
      description: trimmed('description'),
      groups: splitList(fields.groups),
      enabled: fields.enabled !== false,
      analysisConfigJson: trimmed('analysisConfigJson'),
      dataDescriptionJson: trimmed('dataDescriptionJson'),
      resultsIndexName: trimmed('resultsIndexName'),
      analysisLimitsJson: trimmed('analysisLimitsJson'),
      modelPlotConfigJson: trimmed('modelPlotConfigJson'),
      jobAdvancedJson: trimmed('jobAdvancedJson'),
      datafeedIndices: splitList(fields.datafeedIndices),
      datafeedQueryJson: trimmed('datafeedQueryJson'),
      datafeedAdvancedJson: trimmed('datafeedAdvancedJson'),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate ML job configurations against the Elasticsearch _ml constraints.
 * Static rules only — NO network:
 *   - jobId is required and capped; datafeedIndices requires at least one entry
 *   - analysisConfigJson + dataDescriptionJson are required and must parse to
 *     JSON objects
 *   - every optional JSON blob, when present, must parse to a JSON object
 *   - the jobId — a job's logical identity — must be unique across the canvas
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractJobSpecs(ctx.canvas)
  const seenIds = new Set<string>()

  const requireObject = (
    prefix: string,
    field: keyof MlJobSpec,
    label: string,
    raw: string | undefined,
    code: string,
  ) => {
    if (raw && parseJsonObject(raw) === null) {
      errors.push({ field: `${prefix}.${field}`, message: `${label} must be a valid JSON object`, code })
    }
  }

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.jobId) {
      errors.push({ field: `${prefix}.jobId`, message: 'Job ID is required', code: 'required' })
    } else if (spec.jobId.length > MAX_JOB_ID_LENGTH) {
      errors.push({ field: `${prefix}.jobId`, message: `Job ID must be ${MAX_JOB_ID_LENGTH} characters or fewer`, code: 'max_length' })
    }

    if (!spec.analysisConfigJson) {
      errors.push({ field: `${prefix}.analysisConfigJson`, message: 'Analysis Config is required', code: 'required' })
    } else if (parseJsonObject(spec.analysisConfigJson) === null) {
      errors.push({ field: `${prefix}.analysisConfigJson`, message: 'Analysis Config must be a valid JSON object', code: 'invalid_analysis_config' })
    }

    if (!spec.dataDescriptionJson) {
      errors.push({ field: `${prefix}.dataDescriptionJson`, message: 'Data Description is required', code: 'required' })
    } else if (parseJsonObject(spec.dataDescriptionJson) === null) {
      errors.push({ field: `${prefix}.dataDescriptionJson`, message: 'Data Description must be a valid JSON object', code: 'invalid_data_description' })
    }

    requireObject(prefix, 'analysisLimitsJson', 'Analysis Limits', spec.analysisLimitsJson, 'invalid_analysis_limits')
    requireObject(prefix, 'modelPlotConfigJson', 'Model Plot Config', spec.modelPlotConfigJson, 'invalid_model_plot_config')
    requireObject(prefix, 'jobAdvancedJson', 'Advanced Job Settings', spec.jobAdvancedJson, 'invalid_job_advanced')
    requireObject(prefix, 'datafeedQueryJson', 'Datafeed Query', spec.datafeedQueryJson, 'invalid_datafeed_query')
    requireObject(prefix, 'datafeedAdvancedJson', 'Advanced Datafeed Settings', spec.datafeedAdvancedJson, 'invalid_datafeed_advanced')

    if (spec.datafeedIndices.length === 0) {
      errors.push({ field: `${prefix}.datafeedIndices`, message: 'At least one Datafeed Index is required', code: 'required' })
    }

    if (spec.jobId) {
      if (seenIds.has(spec.jobId)) {
        errors.push({
          field: `${prefix}.jobId`,
          message: `Duplicate job "${spec.jobId}" — each job id may only be declared once per canvas`,
          code: 'duplicate_job',
        })
      }
      seenIds.add(spec.jobId)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
