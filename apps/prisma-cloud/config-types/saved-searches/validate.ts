import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Prisma Cloud saved RQL search constraints -------------------------------

export const MAX_NAME_LENGTH = 255
export const MAX_DESC_LENGTH = 2000

/** searchType values Prisma accepts for a saved search. */
export const SEARCH_TYPES = ['config', 'network', 'event', 'iam', 'audit_event', 'asset']
export const CLOUD_TYPES = ['aws', 'azure', 'gcp', 'alibaba_cloud', 'oci']

export interface SavedSearchSpec {
  itemId?: string
  /** name — the identity (unique and immutable in Prisma Cloud). */
  name: string
  description: string
  /** the RQL query. */
  query: string
  searchType: string
  cloudType: string
  /** timeRange — a JSON object ({ type, value, relativeTimeType } | absolute | to_now). */
  timeRange: Record<string, unknown> | null
  /** set when the raw timeRange value could not be parsed as a JSON object. */
  timeRangeError?: string
}

/** A saved search as returned by GET /search/history?filter=saved. */
export interface LiveSavedSearch {
  id?: string
  name?: string
  description?: string | null
  query?: string
  searchType?: string
  cloudType?: string
  timeRange?: Record<string, unknown>
  saved?: boolean
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function parseTimeRange(v: unknown): { timeRange: Record<string, unknown> | null; timeRangeError?: string } {
  if (isObject(v)) return { timeRange: v }
  if (v === null || v === undefined) return { timeRange: null }
  if (typeof v === 'string') {
    const t = v.trim()
    if (!t) return { timeRange: null }
    try {
      const parsed = JSON.parse(t)
      if (isObject(parsed)) return { timeRange: parsed }
      return { timeRange: null, timeRangeError: 'Time range must be a JSON object' }
    } catch {
      return { timeRange: null, timeRangeError: 'Time range must be valid JSON' }
    }
  }
  return { timeRange: null, timeRangeError: 'Time range must be a JSON object' }
}

export function extractSavedSearchSpecs(canvas: CanvasSnapshot): SavedSearchSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const { timeRange, timeRangeError } = parseTimeRange(f.timeRange)
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      query: asString(f.query),
      searchType: asString(f.searchType) || 'config',
      cloudType: asString(f.cloudType),
      timeRange,
      timeRangeError,
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractSavedSearchSpecs(ctx.canvas)
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
        errors.push({ field: `${prefix}.name`, message: `Duplicate saved search "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.query) {
      errors.push({ field: `${prefix}.query`, message: 'An RQL query is required', code: 'required' })
    }

    if (spec.description.length > MAX_DESC_LENGTH) {
      errors.push({ field: `${prefix}.description`, message: `Description must be ${MAX_DESC_LENGTH} characters or fewer`, code: 'too_long' })
    }

    if (spec.searchType && !SEARCH_TYPES.includes(spec.searchType)) {
      warnings.push({ field: `${prefix}.searchType`, message: `Unrecognized search type "${spec.searchType}" (known: ${SEARCH_TYPES.join(', ')})`, code: 'unknown_search_type' })
    }

    if (spec.cloudType && !CLOUD_TYPES.includes(spec.cloudType)) {
      errors.push({ field: `${prefix}.cloudType`, message: `Cloud type must be one of: ${CLOUD_TYPES.join(', ')}`, code: 'invalid_cloud_type' })
    }

    if (spec.timeRangeError) {
      errors.push({ field: `${prefix}.timeRange`, message: spec.timeRangeError, code: 'invalid_time_range' })
    } else if (!spec.timeRange) {
      errors.push({ field: `${prefix}.timeRange`, message: 'A time range is required', code: 'required' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
