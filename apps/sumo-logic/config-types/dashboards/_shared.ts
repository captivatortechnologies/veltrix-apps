// Shared helpers for the Sumo Logic Dashboards config type
// (deploy + rollback + drift + validate).
//
// A dashboard (the "new" panel-based dashboard, not the legacy Report) lives in
// the Content Library at a `folderId` (defaults to the caller's Personal
// folder when left blank — resolved here via GET /v2/content/folders/personal
// so upsert-by-name has a deterministic scope). `panels`, `layout`, `timeRange`
// and `variables` are deeply nested, heavily discriminated structures (six+
// panel types, several time-range shapes, three variable source kinds) — like
// the Monitors config type in this app and Cisco Meraki's Group Policies, they
// are authored as JSON rather than fully typed canvas fields.
//   API: https://help.sumologic.com/docs/api/dashboards-v2/
//   Verified against the official Sumo Logic OpenAPI spec
//   (DashboardRequest / Dashboard / Content, api.sumologic.com/docs/sumologic-api.yaml).

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

/** The full Dashboard body (GET /v2/dashboards/{id}). */
export interface Dashboard {
  id?: string
  title: string
  description?: string
  folderId?: string
  domain?: string
  refreshInterval?: number
  timeRange: unknown
  panels?: unknown[]
  layout?: unknown
  variables?: unknown[]
  theme?: string
  isPublic?: boolean
  [key: string]: unknown
}

const ALLOWED_REFRESH_INTERVALS = new Set([0, 30, 60, 120, 300, 900, 1800, 3600, 7200, 86400])

function s(value: unknown): string {
  return String(value ?? '').trim()
}

/** Coerce a checkbox/string value to a boolean. */
export function normalizeBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const v = s(value).toLowerCase()
  return v === 'true' || v === '1' || v === 'yes'
}

/** Whether a refresh interval (seconds) is one of the values Sumo Logic accepts. */
export function isValidRefreshInterval(value: unknown): boolean {
  if (value === '' || value === null || value === undefined) return true
  const n = Number(value)
  return Number.isFinite(n) && ALLOWED_REFRESH_INTERVALS.has(Math.trunc(n))
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

/** Find a Dashboard-type child by name (case-insensitive, trimmed) within a folder's children. */
export function findDashboardChild(children: ContentChild[] | undefined, title: string): ContentChild | null {
  const n = title.trim().toLowerCase()
  if (!n || !children) return null
  return children.find((c) => c.itemType === 'Dashboard' && s(c.name).toLowerCase() === n) ?? null
}

/** Build the create/update request body (DashboardRequest) from canvas fields. */
export function buildDashboardBody(fields: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    title: s(fields.title),
    description: s(fields.description),
    domain: s(fields.domain),
    timeRange: parseJsonField(fields.timeRange, 'Time Range') ?? { type: 'BeginBoundedTimeRange', from: { type: 'RelativeTimeRangeBoundary', relativeTime: '-1h' } },
    panels: parseJsonField(fields.panels, 'Panels') ?? [],
    layout: parseJsonField(fields.layout, 'Layout') ?? { layoutType: 'Grid', layoutStructures: [] },
    variables: parseJsonField(fields.variables, 'Variables') ?? [],
    theme: s(fields.theme) || 'Light',
    isPublic: normalizeBool(fields.isPublic),
  }
  if (s(fields.folderId)) body.folderId = s(fields.folderId)
  const refreshInterval = Number(fields.refreshInterval)
  if (Number.isFinite(refreshInterval)) body.refreshInterval = Math.trunc(refreshInterval)
  return body
}
