// =============================================================================
// Shared types + helpers for the Datadog Log Indexes config type.
//
// A log index controls retention, daily quota and exclusion filters for the
// logs it retains. Verified against the official Datadog API docs (the index
// `name` IS its permanent identity — chosen once and used as the URL path
// key, like Log-Based Metrics' `id`, unlike most of this app's other
// resources which have a separate server-assigned id):
//   List:   GET    /api/v1/logs/config/indexes
//   Get:    GET    /api/v1/logs/config/indexes/{name}
//   Create: POST   /api/v1/logs/config/indexes
//           body: { name, filter: { query }, exclusion_filters: [{ name,
//           filter: { query, sample_rate }, is_enabled }],
//           num_retention_days, num_flex_logs_retention_days, daily_limit,
//           daily_limit_reset: { reset_time, reset_utc_offset },
//           daily_limit_warning_threshold_percentage, tags }
//   Update: PUT    /api/v1/logs/config/indexes/{name}
//           full-replace ("replacing your current configuration with the new
//           one sent").
//   Delete: DELETE /api/v1/logs/config/indexes/{name}
//           requires the `logs_modify_indexes` permission.
//
// NOT MANAGED (flagged, not faked): index ORDER is a separate singleton
// resource — GET/PUT /api/v1/logs/config/index-order — which controls which
// index a log lands in FIRST when multiple indexes' filters could match. This
// config type never reorders indexes; a newly created index is appended by
// Datadog and may need manual reordering.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

export const MAX_NAME_LENGTH = 80

export interface ExclusionFilter {
  name?: string
  is_enabled?: boolean
  filter?: { query?: string; sample_rate?: number }
}

export interface LogIndex {
  name?: string
  filter?: { query?: string }
  exclusion_filters?: ExclusionFilter[]
  num_retention_days?: number
  daily_limit?: number
  tags?: string[]
  [key: string]: unknown
}

/** The managed subset of an index's fields — fully replaced on every deploy (PUT is full-replace). */
export interface LogIndexBody {
  name: string
  filter: { query: string }
  exclusion_filters: ExclusionFilter[]
  num_retention_days?: number
  daily_limit?: number
  tags: string[]
}

export interface LogIndexSpec {
  name: string
  filterQuery: string
  exclusionFiltersRaw: string
  retentionDaysRaw: string
  dailyLimitRaw: string
  tags: string[]
}

export function readStringArray(value: unknown): string[] {
  const raw: string[] = Array.isArray(value)
    ? value.map((v) => (typeof v === 'string' ? v : String(v ?? '')))
    : typeof value === 'string'
      ? value.split(/[\n,]+/)
      : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const trimmed = entry.trim()
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed)
      out.push(trimmed)
    }
  }
  return out
}

export function extractLogIndexSpec(fields: Record<string, unknown>): LogIndexSpec {
  const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  const num = (value: unknown): string => (typeof value === 'number' ? String(value) : str(value))
  return {
    name: str(fields.name),
    filterQuery: str(fields.filter_query),
    exclusionFiltersRaw: typeof fields.exclusion_filters === 'string' ? fields.exclusion_filters.trim() : '',
    retentionDaysRaw: num(fields.num_retention_days),
    dailyLimitRaw: num(fields.daily_limit),
    tags: readStringArray(fields.tags),
  }
}

export function extractLogIndexSpecs(canvas: CanvasSnapshot): LogIndexSpec[] {
  const items = (canvas.items ?? canvas.sections ?? []) as Array<{ fields?: Record<string, unknown> }>
  return items.map((item) => extractLogIndexSpec(item.fields ?? {}))
}

export function indexKey(name: string): string {
  return name.trim().toLowerCase()
}

export interface ParsedJson<T> {
  value: T | undefined
  ok: boolean
}

export function parseJsonArray(raw: string): ParsedJson<unknown[]> {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return { value: undefined, ok: true }
  try {
    const parsed = JSON.parse(trimmed)
    if (!Array.isArray(parsed)) return { value: undefined, ok: false }
    return { value: parsed, ok: true }
  } catch {
    return { value: undefined, ok: false }
  }
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse an optional numeric field: '' -> undefined; otherwise a finite number, or NaN when malformed. */
export function parseOptionalNumber(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : NaN
}

function normalizeExclusionFilters(raw: unknown[]): ExclusionFilter[] {
  return raw.filter(isJsonObject).map((f) => ({
    name: typeof f.name === 'string' ? f.name : '',
    is_enabled: typeof f.is_enabled === 'boolean' ? f.is_enabled : true,
    filter: { query: isJsonObject(f.filter) && typeof f.filter.query === 'string' ? f.filter.query : '*' },
  }))
}

export function buildLogIndexBody(
  spec: LogIndexSpec,
  exclusionFilters: unknown[],
  retentionDays: number | undefined,
  dailyLimit: number | undefined,
): LogIndexBody {
  const body: LogIndexBody = {
    name: spec.name,
    filter: { query: spec.filterQuery },
    exclusion_filters: normalizeExclusionFilters(exclusionFilters),
    tags: spec.tags,
  }
  if (retentionDays !== undefined) body.num_retention_days = retentionDays
  if (dailyLimit !== undefined) body.daily_limit = dailyLimit
  return body
}

/** Rebuild a LogIndexBody from a captured LIVE index (rollback restore path). */
export function indexToBody(index: LogIndex): LogIndexBody {
  const body: LogIndexBody = {
    name: String(index.name ?? ''),
    filter: { query: String(index.filter?.query ?? '') },
    exclusion_filters: Array.isArray(index.exclusion_filters) ? normalizeExclusionFilters(index.exclusion_filters) : [],
    tags: Array.isArray(index.tags) ? index.tags : [],
  }
  if (typeof index.num_retention_days === 'number') body.num_retention_days = index.num_retention_days
  if (typeof index.daily_limit === 'number') body.daily_limit = index.daily_limit
  return body
}
