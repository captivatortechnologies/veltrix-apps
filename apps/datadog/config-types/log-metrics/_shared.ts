// =============================================================================
// Shared types + helpers for the Datadog Log-Based Metrics config type.
//
// A log-based metric turns matching logs into a custom metric. Verified
// against the official Datadog API docs (a JSON:API resource whose `id` IS
// the metric name — chosen once at creation and used as the permanent path
// key, unlike every other resource in this app which has a separate
// server-assigned id):
//   List:   GET   /api/v2/logs/config/metrics
//   Get:    GET   /api/v2/logs/config/metrics/{metric_id}
//   Create: POST  /api/v2/logs/config/metrics
//           https://docs.datadoghq.com/api/latest/logs-metrics/create-a-log-based-metric/
//           body: { "data": { "type": "logs_metrics", "id": "<metric name>",
//           "attributes": { compute: { aggregation_type: "count"|
//           "distribution", path?, include_percentiles? }, filter: { query },
//           group_by: [{ path, tag_name }] } } }
//   Update: PATCH /api/v2/logs/config/metrics/{metric_id}
//           https://docs.datadoghq.com/api/latest/logs-metrics/update-a-log-based-metric/
//           Partial update. `compute.aggregation_type` and `compute.path` are
//           NOT listed as updatable in the request model (only in the
//           response model) — i.e. CREATE-ONLY / immutable. This app never
//           sends them on update; only `filter`, `group_by` and
//           `compute.include_percentiles` are sent.
//   Delete: DELETE /api/v2/logs/config/metrics/{metric_id}
//
// Because `id` IS the name, reconciliation is a DIRECT lookup
// (GET .../{id}) rather than list+match-by-name used everywhere else in this
// app.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

export const AGGREGATION_TYPES = ['count', 'distribution'] as const
/** Datadog metric-name convention: lowercase, dot/underscore separated. Loosely enforced. */
export const METRIC_ID_RE = /^[a-zA-Z][a-zA-Z0-9_.]*$/
export const MAX_ID_LENGTH = 200

export interface LogMetricCompute {
  aggregation_type?: string
  path?: string
  include_percentiles?: boolean
}

export interface LogMetricGroupBy {
  path?: string
  tag_name?: string
}

export interface LogMetricAttributes {
  compute?: LogMetricCompute
  filter?: { query?: string }
  group_by?: LogMetricGroupBy[]
  [key: string]: unknown
}

export interface LogMetricResource {
  id?: string
  type?: string
  attributes?: LogMetricAttributes
}

/** Full body — used only for CREATE. */
export interface LogMetricCreateBody {
  compute: LogMetricCompute
  filter: { query: string }
  group_by: LogMetricGroupBy[]
}

/** Mutable-only body — used for UPDATE (aggregation_type / path are create-only). */
export interface LogMetricUpdateBody {
  compute: { include_percentiles: boolean }
  filter: { query: string }
  group_by: LogMetricGroupBy[]
}

export interface LogMetricSpec {
  id: string
  aggregationType: string
  path: string
  includePercentiles: boolean
  filterQuery: string
  groupByRaw: string
}

export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

export function extractLogMetricSpec(fields: Record<string, unknown>): LogMetricSpec {
  const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  return {
    id: str(fields.id),
    aggregationType: str(fields.aggregation_type) || 'count',
    path: str(fields.path),
    includePercentiles: readBool(fields.include_percentiles, false),
    filterQuery: str(fields.filter_query),
    groupByRaw: typeof fields.group_by === 'string' ? fields.group_by.trim() : '',
  }
}

export function extractLogMetricSpecs(canvas: CanvasSnapshot): LogMetricSpec[] {
  const items = (canvas.items ?? canvas.sections ?? []) as Array<{ fields?: Record<string, unknown> }>
  return items.map((item) => extractLogMetricSpec(item.fields ?? {}))
}

export function metricKey(id: string): string {
  return id.trim().toLowerCase()
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

function normalizeGroupBy(raw: unknown[]): LogMetricGroupBy[] {
  return raw.filter(isJsonObject).map((g) => ({
    path: typeof g.path === 'string' ? g.path : '',
    ...(typeof g.tag_name === 'string' && g.tag_name ? { tag_name: g.tag_name } : {}),
  }))
}

export function buildCreateBody(spec: LogMetricSpec, groupBy: unknown[]): LogMetricCreateBody {
  const compute: LogMetricCompute = { aggregation_type: spec.aggregationType }
  if (spec.aggregationType === 'distribution') {
    compute.path = spec.path
    compute.include_percentiles = spec.includePercentiles
  }
  return { compute, filter: { query: spec.filterQuery }, group_by: normalizeGroupBy(groupBy) }
}

/** Only the mutable subset — aggregation_type/path are create-only and never sent on update. */
export function buildUpdateBody(spec: LogMetricSpec, groupBy: unknown[]): LogMetricUpdateBody {
  return {
    compute: { include_percentiles: spec.includePercentiles },
    filter: { query: spec.filterQuery },
    group_by: normalizeGroupBy(groupBy),
  }
}

/** Rebuild an UPDATE body (mutable subset) from captured LIVE attributes (rollback restore path). */
export function attributesToUpdateBody(attrs: LogMetricAttributes): LogMetricUpdateBody {
  return {
    compute: { include_percentiles: attrs.compute?.include_percentiles ?? false },
    filter: { query: String(attrs.filter?.query ?? '') },
    group_by: Array.isArray(attrs.group_by) ? normalizeGroupBy(attrs.group_by) : [],
  }
}

export function toCreatePayload(id: string, body: LogMetricCreateBody): { data: { type: 'logs_metrics'; id: string; attributes: LogMetricCreateBody } } {
  return { data: { type: 'logs_metrics', id, attributes: body } }
}

export function toUpdatePayload(body: LogMetricUpdateBody): { data: { type: 'logs_metrics'; attributes: LogMetricUpdateBody } } {
  return { data: { type: 'logs_metrics', attributes: body } }
}
