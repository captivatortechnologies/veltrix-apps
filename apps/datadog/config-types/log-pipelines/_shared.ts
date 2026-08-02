// =============================================================================
// Shared types + helpers for the Datadog Log Pipelines config type.
//
// Verified against the official Datadog API docs:
//   List:   GET    /api/v1/logs/config/pipelines
//   Get:    GET    /api/v1/logs/config/pipelines/{pipeline_id}
//           https://docs.datadoghq.com/api/latest/logs-pipelines/get-a-pipeline/
//   Create: POST   /api/v1/logs/config/pipelines
//           https://docs.datadoghq.com/api/latest/logs-pipelines/create-a-pipeline/
//           requires the "logs_write_pipelines" permission.
//   Update: PUT    /api/v1/logs/config/pipelines/{pipeline_id}
//           https://docs.datadoghq.com/api/latest/logs-pipelines/update-a-pipeline/
//           full-replace: "updates your pipeline configuration by REPLACING
//           your current configuration with the new one sent".
//   Delete: DELETE /api/v1/logs/config/pipelines/{pipeline_id}
//           https://docs.datadoghq.com/api/latest/logs-pipelines/delete-a-pipeline/
//           200 OK.
//
// NOT MANAGED (flagged, not faked): pipeline ORDER is a separate singleton
// resource — GET/PUT /api/v1/logs/config/pipeline-order (confirmed a distinct
// endpoint from the per-pipeline CRUD above, on the same docs index page:
// https://docs.datadoghq.com/api/latest/logs-pipelines/). This config type
// creates/updates/deletes individual pipelines only; it never reorders them.
// A newly created pipeline is appended by Datadog and may need manual
// reordering in the Datadog UI (Logs > Pipelines) for its processors to take
// effect ahead of a catch-all/exclusion pipeline.
//
// UNVERIFIED (flagged): the dedicated "list pipelines" doc page 404'd during
// research. Modeled here as a plain JSON array — consistent with the v1 API's
// flat (non-JSON:API) convention confirmed above for get/create/update, and
// with other v1 list endpoints (e.g. GET /api/v1/monitor) — with a defensive
// unwrap in case it is instead wrapped (e.g. {"pipelines":[...]}).
//
// Processor "type" enum verified against the create-a-pipeline reference.
// Per-processor-type fields (e.g. a grok-parser's grok rules, a
// category-processor's category list) are NOT individually modeled/validated
// — there are 17 processor types each with distinct sub-schemas, and this
// app's research could not fully verify every one against an authoritative
// source. Only the common envelope (type/name/is_enabled) is validated; the
// rest of each processor object is passed through to Datadog's API as
// authored, which is the final arbiter of its shape.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

/** `processors[].type` — verified against the create-a-pipeline API reference. */
export const PROCESSOR_TYPES = [
  'grok-parser',
  'date-remapper',
  'status-remapper',
  'service-remapper',
  'message-remapper',
  'attribute-remapper',
  'url-parser',
  'user-agent-parser',
  'category-processor',
  'arithmetic-processor',
  'string-builder-processor',
  'pipeline',
  'geo-ip-parser',
  'lookup-processor',
  'trace-id-remapper',
  'span-id-remapper',
  'array-processor',
] as const

export const MAX_NAME_LENGTH = 255

export interface LogPipeline {
  id?: string
  name?: string
  description?: string
  is_enabled?: boolean
  is_read_only?: boolean
  filter?: { query?: string }
  processors?: unknown[]
  [key: string]: unknown
}

/** The managed subset of a pipeline's fields — fully replaced on every deploy. */
export interface PipelineBody {
  name: string
  description: string
  is_enabled: boolean
  filter: { query: string }
  processors: unknown[]
}

export interface PipelineSpec {
  name: string
  description: string
  isEnabled: boolean
  filterQuery: string
  processorsRaw: string
}

/** Coerce a checkbox-ish value to boolean, falling back when unset. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

export function extractPipelineSpec(fields: Record<string, unknown>): PipelineSpec {
  const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  return {
    name: str(fields.name),
    description: str(fields.description),
    isEnabled: readBool(fields.is_enabled, true),
    filterQuery: typeof fields.filter_query === 'string' ? fields.filter_query.trim() : '',
    processorsRaw: typeof fields.processors === 'string' ? fields.processors.trim() : '',
  }
}

export function extractPipelineSpecs(canvas: CanvasSnapshot): PipelineSpec[] {
  const items = (canvas.items ?? canvas.sections ?? []) as Array<{ fields?: Record<string, unknown> }>
  return items.map((item) => extractPipelineSpec(item.fields ?? {}))
}

export function pipelineKey(name: string): string {
  return name.trim().toLowerCase()
}

export function findPipelineByName(pipelines: LogPipeline[], name: string): LogPipeline | null {
  const key = pipelineKey(name)
  if (!key) return null
  return pipelines.find((p) => typeof p.name === 'string' && pipelineKey(p.name) === key) ?? null
}

/** True when a live pipeline is a Datadog-managed integration pipeline — PROTECTED. */
export function isReadOnlyPipeline(pipeline: LogPipeline | null | undefined): boolean {
  return pipeline?.is_read_only === true
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

export function buildPipelineBody(spec: PipelineSpec, processors: unknown[]): PipelineBody {
  return {
    name: spec.name,
    description: spec.description,
    is_enabled: spec.isEnabled,
    filter: { query: spec.filterQuery },
    processors,
  }
}

/** Rebuild a PipelineBody from a captured LIVE pipeline (rollback restore path). */
export function pipelineToBody(pipeline: LogPipeline): PipelineBody {
  return {
    name: String(pipeline.name ?? ''),
    description: String(pipeline.description ?? ''),
    is_enabled: pipeline.is_enabled ?? true,
    filter: { query: String(pipeline.filter?.query ?? '') },
    processors: Array.isArray(pipeline.processors) ? pipeline.processors : [],
  }
}

/**
 * Subset-aware deep equality (see the identical helper in
 * ../security-monitoring-rules/_shared.ts for the full rationale): does
 * `actual` satisfy everything `expected` declares? Arrays compare element-wise
 * at the same index (length must match); objects recurse key-by-key (the live
 * object may carry extra keys); primitives compare by value.
 */
export function deepSubsetEqual(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length !== actual.length) return false
    return expected.every((item, i) => deepSubsetEqual(item, actual[i]))
  }
  if (isJsonObject(expected)) {
    if (!isJsonObject(actual)) return false
    return Object.keys(expected).every((key) => deepSubsetEqual(expected[key], actual[key]))
  }
  return expected === actual
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
