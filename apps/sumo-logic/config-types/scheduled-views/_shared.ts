// Shared helpers for the Sumo Logic Scheduled Views config type
// (deploy + rollback + drift + validate).
//
// A scheduled view is a continuous, pre-computed index built from a query. The
// list endpoint returns them inside a { data: [...], next } envelope and pages
// via a `?token=` query parameter. `query`, `indexName` and `startTime` are only
// meaningful at CREATE time — Sumo Logic rejects them on update, so this type
// upserts by `indexName` but only ever sends the mutable subset on update.
//   API: https://www.sumologic.com/help/docs/api/scheduled-views/
//   Verified against the official Sumo Logic OpenAPI spec
//   (CreateScheduledViewDefinition / UpdateScheduledViewDefinition,
//   api.sumologic.com/docs/sumologic-api.yaml).

/** One Sumo Logic scheduled view. */
export interface ScheduledView {
  id?: string
  /** Name of the index the scheduled view materializes into — the stable identity. Immutable after create. */
  indexName: string
  /** The query defining the data included in the view. Immutable after create. */
  query: string
  /** RFC3339 start timestamp. Immutable after create. */
  startTime?: string
  /** Days to retain data, or -1 for the account default. Mutable. */
  retentionPeriod?: number
  /** Optional data forwarding destination id. Mutable. */
  dataForwardingId?: string
  /** AutoParse or Manual. Set at create time; not accepted on update. */
  parsingMode?: string
  /** IANA time zone. Mutable. */
  timeZone?: string
  description?: string
  status?: string
  [key: string]: unknown
}

/** The { data: [...], next } envelope returned by GET /scheduledViews. */
export interface ScheduledViewList {
  data?: ScheduledView[]
  next?: string | null
}

function s(value: unknown): string {
  return String(value ?? '').trim()
}

/** Unwrap the { data: [...] } list envelope into a flat array of scheduled views. */
export function scheduledViewsFromList(list: unknown): ScheduledView[] {
  if (Array.isArray(list)) return list as ScheduledView[]
  const data = (list as ScheduledViewList | null | undefined)?.data
  return Array.isArray(data) ? data : []
}

/** Find a live scheduled view by index name (case-insensitive, trimmed) — the identity. */
export function findScheduledView(views: ScheduledView[], indexName: string): ScheduledView | null {
  const n = indexName.trim().toLowerCase()
  if (!n) return null
  return views.find((v) => s(v.indexName).toLowerCase() === n) ?? null
}

/** Parse a retention value into whole days. Blank/non-numeric → undefined. -1 preserved. */
export function toRetentionDays(value: unknown): number | undefined {
  if (value === '' || value === null || value === undefined) return undefined
  const n = Number(value)
  if (!Number.isFinite(n)) return undefined
  return Math.trunc(n)
}

/** Coerce a checkbox/string value to a boolean. */
export function normalizeBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const v = s(value).toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

/** Create-request body — the only place `query`, `indexName` and `startTime` are ever sent. */
export function buildScheduledViewCreateBody(fields: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    indexName: s(fields.indexName),
    query: s(fields.query),
    startTime: s(fields.startTime),
  }
  const retention = toRetentionDays(fields.retentionPeriod)
  body.retentionPeriod = retention !== undefined ? retention : -1
  const forwardingId = s(fields.dataForwardingId)
  if (forwardingId) body.dataForwardingId = forwardingId
  body.parsingMode = s(fields.parsingMode) || 'Manual'
  body.timeZone = s(fields.timeZone) || 'UTC'
  body.description = s(fields.description)
  return body
}

/**
 * Update-request body — only the mutable subset. `reduceRetentionPeriodImmediately`
 * is included only when the declared retention is lower than the live retention
 * (Sumo Logic requires an explicit opt-in to purge data early rather than let it
 * age out over the next seven days).
 */
export function buildScheduledViewUpdateBody(fields: Record<string, unknown>, existing?: ScheduledView | null): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  const retention = toRetentionDays(fields.retentionPeriod)
  body.retentionPeriod = retention !== undefined ? retention : -1
  const forwardingId = s(fields.dataForwardingId)
  if (forwardingId) body.dataForwardingId = forwardingId
  if (s(fields.timeZone)) body.timeZone = s(fields.timeZone)
  body.description = s(fields.description)
  if (
    typeof existing?.retentionPeriod === 'number' &&
    typeof body.retentionPeriod === 'number' &&
    body.retentionPeriod < existing.retentionPeriod
  ) {
    body.reduceRetentionPeriodImmediately = normalizeBool(fields.reduceRetentionPeriodImmediately)
  }
  return body
}
