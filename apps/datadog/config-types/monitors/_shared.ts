// =============================================================================
// Shared types + helpers for the Datadog Monitors config type.
//
// Verified against the official Datadog API docs:
//   List:    GET    /api/v1/monitor
//   Get:     GET    /api/v1/monitor/{monitor_id}
//   Create:  POST   /api/v1/monitor
//            https://docs.datadoghq.com/api/latest/monitors/create-a-monitor/
//   Update:  PUT    /api/v1/monitor/{monitor_id}
//            https://docs.datadoghq.com/api/latest/monitors/edit-a-monitor/
//            full-replace ("comprehensive request model that includes all
//            monitor properties").
//   Delete:  DELETE /api/v1/monitor/{monitor_id}
//            https://docs.datadoghq.com/api/latest/monitors/delete-a-monitor/
//            200 { "deleted_monitor_id": <id> }; accepts an optional
//            `force=true` query param to delete a monitor still referenced by
//            an SLO/composite monitor — NOT USED by this app (flagged): a
//            reconcile/rollback that would delete a referenced monitor fails
//            with a clear error instead of forcing the deletion through;
//            clear the reference in Datadog first.
//
// UNVERIFIED / FLAGGED — `type`: research (WebFetch summaries of the official
// docs) surfaced ~15 monitor type values but could not fully confirm the
// complete, authoritative enum against one source (and omitted "metric
// alert", the best-established classic monitor type, from at least one pass).
// Rather than hard-reject a legitimate type this app's research missed, `type`
// is modeled as free text with a WARNING (never an error) when it doesn't
// match the well-documented common set below — Datadog's own API is the
// final arbiter and will 400 on a truly invalid type.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

/**
 * Well-documented common monitor `type` values, for validate.ts's WARNING
 * check and canvas help text ONLY — NOT an enforced enum (see the header
 * comment above for why).
 */
export const KNOWN_MONITOR_TYPES = [
  'metric alert',
  'query alert',
  'service check',
  'event alert',
  'event-v2 alert',
  'log alert',
  'process alert',
  'rum alert',
  'trace-analytics alert',
  'slo alert',
  'audit alert',
  'composite',
  'ci-pipelines alert',
  'ci-tests alert',
  'error-tracking alert',
  'database-monitoring alert',
  'network alert',
  'network-performance alert',
  'cost alert',
  'network-path alert',
] as const

export const MAX_NAME_LENGTH = 255
export const MIN_PRIORITY = 1
export const MAX_PRIORITY = 5

export interface DatadogMonitor {
  id?: number
  name?: string
  type?: string
  query?: string
  message?: string
  tags?: string[]
  priority?: number | null
  options?: Record<string, unknown>
  [key: string]: unknown
}

/** The managed subset of a monitor's fields — fully replaced on every deploy. */
export interface MonitorBody {
  name: string
  type: string
  query: string
  message: string
  tags: string[]
  options: Record<string, unknown>
  priority?: number
}

export interface MonitorSpec {
  name: string
  type: string
  query: string
  message: string
  tags: string[]
  priorityRaw: string
  optionsRaw: string
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

export function extractMonitorSpec(fields: Record<string, unknown>): MonitorSpec {
  const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  return {
    name: str(fields.name),
    type: str(fields.type),
    query: str(fields.query),
    message: str(fields.message),
    tags: readStringArray(fields.tags),
    priorityRaw: typeof fields.priority === 'number' ? String(fields.priority) : str(fields.priority),
    optionsRaw: typeof fields.options === 'string' ? fields.options.trim() : '',
  }
}

export function extractMonitorSpecs(canvas: CanvasSnapshot): MonitorSpec[] {
  const items = (canvas.items ?? canvas.sections ?? []) as Array<{ fields?: Record<string, unknown> }>
  return items.map((item) => extractMonitorSpec(item.fields ?? {}))
}

export function monitorKey(name: string): string {
  return name.trim().toLowerCase()
}

export function findMonitorByName(monitors: DatadogMonitor[], name: string): DatadogMonitor | null {
  const key = monitorKey(name)
  if (!key) return null
  return monitors.find((m) => typeof m.name === 'string' && monitorKey(m.name) === key) ?? null
}

export interface ParsedJson<T> {
  value: T | undefined
  ok: boolean
}

export function parseJsonObject(raw: string): ParsedJson<Record<string, unknown>> {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return { value: undefined, ok: true }
  try {
    const parsed = JSON.parse(trimmed)
    if (!isJsonObject(parsed)) return { value: undefined, ok: false }
    return { value: parsed, ok: true }
  } catch {
    return { value: undefined, ok: false }
  }
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse the priority field: '' -> undefined (leave unset); otherwise a finite integer, or NaN when malformed. */
export function parsePriority(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : NaN
}

export function buildMonitorBody(spec: MonitorSpec, options: Record<string, unknown>, priority: number | undefined): MonitorBody {
  const body: MonitorBody = {
    name: spec.name,
    type: spec.type,
    query: spec.query,
    message: spec.message,
    tags: spec.tags,
    options,
  }
  if (priority !== undefined) body.priority = priority
  return body
}

/** Rebuild a MonitorBody from a captured LIVE monitor (rollback restore path). */
export function monitorToBody(monitor: DatadogMonitor): MonitorBody {
  const body: MonitorBody = {
    name: String(monitor.name ?? ''),
    type: String(monitor.type ?? ''),
    query: String(monitor.query ?? ''),
    message: String(monitor.message ?? ''),
    tags: Array.isArray(monitor.tags) ? monitor.tags : [],
    options: isJsonObject(monitor.options) ? monitor.options : {},
  }
  if (typeof monitor.priority === 'number') body.priority = monitor.priority
  return body
}

/**
 * Subset-aware deep equality (see the identical helper in
 * ../security-monitoring-rules/_shared.ts for the full rationale).
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

/** Case-sensitive set-equality for two tag lists (order-insensitive). */
export function sameTagSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a)
  return b.every((t) => setA.has(t))
}
