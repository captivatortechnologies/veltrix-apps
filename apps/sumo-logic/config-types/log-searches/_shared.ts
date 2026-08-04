// Shared helpers for the Sumo Logic Log Searches config type
// (deploy + rollback + drift + validate).
//
// A Log Search is a saved (optionally scheduled) search living in the Content
// Library at a `parentId` folder (the same tree the Folders and Dashboards
// config types in this app use) — defaults to the caller's Personal folder
// when left blank, resolved here via GET /v2/content/folders/personal. The
// list endpoint uses yet another envelope shape than most of this app's other
// paged endpoints: `{ logSearches: [...], token }` rather than
// `{ data: [...], next }` — handled via `listPaged`'s `dataField`/
// `nextTokenField` options.
//
// `timeRange` and `schedule` (cron/interval + notification, itself a
// discriminated union of Email/Webhook/ServiceNow/SaveToView/SaveToLookup/Alert
// task types) are deeply nested — like Monitors and Dashboards in this app,
// they are authored as JSON rather than fully typed canvas fields.
//   API: https://help.sumologic.com/docs/api/log-searches/
//   Verified against the official Sumo Logic OpenAPI spec
//   (LogSearchDefinition / SaveLogSearchRequest / LogSearch,
//   api.sumologic.com/docs/sumologic-api.yaml).

/** A content item summary as returned inside a folder's `children` list. */
export interface ContentChild {
  id: string
  name: string
  /** Folder | Search | Report | Dashboard | Lookups. */
  itemType: string
  [key: string]: unknown
}

/** A folder read (GET /v2/content/folders/{id}), including its immediate children. */
export interface FolderResponse {
  id: string
  children?: ContentChild[]
  [key: string]: unknown
}

/** The full Log Search body (GET /v1/logSearches/{id}). */
export interface LogSearch {
  id?: string
  name: string
  description?: string
  parentId?: string
  queryString: string
  runByReceiptTime?: boolean
  intervalTimeType?: string
  timeRange: unknown
  parsingMode?: string
  queryParameters?: unknown[]
  schedule?: unknown
  properties?: string
  [key: string]: unknown
}

function s(value: unknown): string {
  return String(value ?? '').trim()
}

/** Coerce a checkbox/string value to a boolean. */
export function normalizeBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const v = s(value).toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

/** Parse a canvas JSON-blob field into its value. Throws with a clear message on malformed JSON. */
export function parseJsonField(value: unknown, fieldLabel: string): unknown {
  if (value === '' || value === null || value === undefined) return undefined
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`${fieldLabel} must be well-formed JSON`)
  }
}

/** Same as parseJsonField but returns a sentinel instead of throwing, for validate.ts. */
export function isValidJsonField(value: unknown): boolean {
  if (value === '' || value === null || value === undefined) return true
  if (typeof value !== 'string') return true
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

/** Find a Search-type child by name (case-insensitive, trimmed) within a folder's children. */
export function findLogSearchChild(children: ContentChild[] | undefined, name: string): ContentChild | null {
  const n = name.trim().toLowerCase()
  if (!n || !children) return null
  return children.find((c) => c.itemType === 'Search' && s(c.name).toLowerCase() === n) ?? null
}

/** Build the create-request body (SaveLogSearchRequest — the only place `parentId` is sent). */
export function buildLogSearchCreateBody(fields: Record<string, unknown>, parentId: string): Record<string, unknown> {
  return { ...buildLogSearchUpdateBody(fields), parentId }
}

/** Build the update-request body (LogSearchDefinition — no `parentId`; a log search is not re-parented here). */
export function buildLogSearchUpdateBody(fields: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: s(fields.name),
    description: s(fields.description),
    queryString: s(fields.queryString),
    runByReceiptTime: normalizeBool(fields.runByReceiptTime),
    timeRange: parseJsonField(fields.timeRange, 'Time Range') ?? { type: 'BeginBoundedTimeRange', from: { type: 'RelativeTimeRangeBoundary', relativeTime: '-15m' } },
    parsingMode: s(fields.parsingMode) || 'Manual',
  }
  if (s(fields.intervalTimeType)) body.intervalTimeType = s(fields.intervalTimeType)
  if (s(fields.properties)) body.properties = s(fields.properties)
  const queryParameters = parseJsonField(fields.queryParameters, 'Query Parameters')
  if (Array.isArray(queryParameters) && queryParameters.length) body.queryParameters = queryParameters
  const schedule = parseJsonField(fields.schedule, 'Schedule')
  if (schedule) body.schedule = schedule
  return body
}
