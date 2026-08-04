// =============================================================================
// Shared types + helpers for the Datadog SLOs (Service Level Objectives)
// config type.
//
// Verified against the official Datadog API docs:
//   List:   GET    /api/v1/slo
//   Get:    GET    /api/v1/slo/{slo_id}
//   Create: POST   /api/v1/slo
//   Update: PUT    /api/v1/slo/{slo_id}
//   Delete: DELETE /api/v1/slo/{slo_id}
//           https://docs.datadoghq.com/api/latest/service-level-objectives/
//
// An SLO is either:
//   - "metric": a numerator/denominator metric query pair
//     (query: { numerator, denominator }); OR
//   - "monitor": one or more existing monitor ids (monitor_ids) whose
//     combined uptime is measured.
// Both types share name, description, tags, thresholds (an array of
// {timeframe, target, warning?}) and optional groups (monitor type only).
// This app models both; "time_slice" (a newer third SLO type Datadog has
// since added) is NOT modeled — this app's research did not turn up a
// confirmed request-body reference for it, so declaring type="time_slice" is
// passed straight through to Datadog's API rather than validated in depth
// (flagged: FUTURE WORK, not faked).
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

export const SLO_TYPES = ['metric', 'monitor', 'time_slice'] as const
/** Types this app deep-validates the query/monitor_ids shape for. */
export const MODELED_SLO_TYPES: ReadonlySet<string> = new Set(['metric', 'monitor'])
export const TIMEFRAMES = ['7d', '30d', '90d'] as const
export const MAX_NAME_LENGTH = 255

export interface SloThreshold {
  timeframe?: string
  target?: number
  warning?: number
  target_display?: string
  warning_display?: string
}

export interface DatadogSlo {
  id?: string
  name?: string
  type?: string
  description?: string
  tags?: string[]
  thresholds?: SloThreshold[]
  query?: { numerator?: string; denominator?: string }
  monitor_ids?: number[]
  groups?: string[]
  [key: string]: unknown
}

/** The managed subset of an SLO's fields — fully replaced on every deploy. */
export interface SloBody {
  name: string
  type: string
  description: string
  tags: string[]
  thresholds: SloThreshold[]
  query?: { numerator: string; denominator: string }
  monitor_ids?: number[]
  groups?: string[]
}

export interface SloSpec {
  name: string
  type: string
  description: string
  tags: string[]
  thresholdsRaw: string
  numerator: string
  denominator: string
  monitorIdsRaw: string
  groups: string[]
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

export function extractSloSpec(fields: Record<string, unknown>): SloSpec {
  const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  return {
    name: str(fields.name),
    type: str(fields.type) || 'metric',
    description: str(fields.description),
    tags: readStringArray(fields.tags),
    thresholdsRaw: typeof fields.thresholds === 'string' ? fields.thresholds.trim() : '',
    numerator: str(fields.numerator),
    denominator: str(fields.denominator),
    monitorIdsRaw: typeof fields.monitor_ids === 'string' ? fields.monitor_ids.trim() : '',
    groups: readStringArray(fields.groups),
  }
}

export function extractSloSpecs(canvas: CanvasSnapshot): SloSpec[] {
  const items = (canvas.items ?? canvas.sections ?? []) as Array<{ fields?: Record<string, unknown> }>
  return items.map((item) => extractSloSpec(item.fields ?? {}))
}

export function sloKey(name: string): string {
  return name.trim().toLowerCase()
}

export function findSloByName(slos: DatadogSlo[], name: string): DatadogSlo | null {
  const key = sloKey(name)
  if (!key) return null
  return slos.find((s) => typeof s.name === 'string' && sloKey(s.name) === key) ?? null
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

/** Parse a comma/newline-separated list of integer monitor ids. */
export function parseMonitorIds(raw: string): { ids: number[]; ok: boolean } {
  const parts = readStringArray(raw)
  if (parts.length === 0) return { ids: [], ok: true }
  const ids: number[] = []
  for (const part of parts) {
    const n = Number(part)
    if (!Number.isInteger(n)) return { ids: [], ok: false }
    ids.push(n)
  }
  return { ids, ok: true }
}

function normalizeThresholds(raw: unknown[]): SloThreshold[] {
  return raw.filter(isJsonObject).map((t) => ({
    timeframe: typeof t.timeframe === 'string' ? t.timeframe : '',
    target: typeof t.target === 'number' ? t.target : 0,
    ...(typeof t.warning === 'number' ? { warning: t.warning } : {}),
  }))
}

export function buildSloBody(spec: SloSpec, thresholds: unknown[], monitorIds: number[]): SloBody {
  const body: SloBody = {
    name: spec.name,
    type: spec.type,
    description: spec.description,
    tags: spec.tags,
    thresholds: normalizeThresholds(thresholds),
  }
  if (spec.type === 'metric') {
    body.query = { numerator: spec.numerator, denominator: spec.denominator }
  } else if (spec.type === 'monitor') {
    body.monitor_ids = monitorIds
    if (spec.groups.length > 0) body.groups = spec.groups
  }
  return body
}

/** Rebuild an SloBody from a captured LIVE SLO (rollback restore path). */
export function sloToBody(slo: DatadogSlo): SloBody {
  const body: SloBody = {
    name: String(slo.name ?? ''),
    type: String(slo.type ?? 'metric'),
    description: String(slo.description ?? ''),
    tags: Array.isArray(slo.tags) ? slo.tags : [],
    thresholds: Array.isArray(slo.thresholds) ? normalizeThresholds(slo.thresholds) : [],
  }
  if (slo.type === 'metric' && slo.query) {
    body.query = { numerator: String(slo.query.numerator ?? ''), denominator: String(slo.query.denominator ?? '') }
  } else if (slo.type === 'monitor') {
    body.monitor_ids = Array.isArray(slo.monitor_ids) ? slo.monitor_ids : []
    if (Array.isArray(slo.groups) && slo.groups.length > 0) body.groups = slo.groups
  }
  return body
}
