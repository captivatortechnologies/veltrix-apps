// Shared helpers for the Sumo Logic Monitors config type
// (deploy + rollback + drift + validate).
//
// A Monitor is an alert definition (query + trigger conditions + notification
// actions) living in the Monitors Library — a SEPARATE folder tree from the
// Content Library used by Dashboards/Log Searches/Folders. Monitor names are
// unique per PARENT FOLDER, not globally, and — unusually for this app — there
// is no plain "list all monitors" endpoint: monitors are discovered by reading
// a folder's `children` (GET /v1/monitors/{parentId}) or via full-text search
// (GET /v1/monitors/search). This type upserts by matching a declared `name`
// against the children of its resolved `parentId` (defaulting to the always-
// present root folder, GET /v1/monitors/root, when left blank).
//
// `queries`, `triggers` and `notifications` are deeply nested, heavily
// discriminated structures (11 detection methods, a dozen+ notification
// connection types) — following the Cisco Meraki Group Policies / Sumo Logic
// Dashboards precedent in this app, they are authored as JSON blobs rather
// than fully typed canvas fields.
//   API: https://help.sumologic.com/docs/api/monitors/
//   Verified against the official Sumo Logic OpenAPI spec
//   (MonitorsLibraryMonitor / MonitorsLibraryBaseResponse / TriggerCondition,
//   api.sumologic.com/docs/sumologic-api.yaml).

export { canonicalJson } from '../../lib/sumoLogicApi'

/** A monitor or folder summary as returned inside a folder's `children` list. */
export interface MonitorsLibraryChild {
  id: string
  name: string
  /** 'Monitor' or 'Folder' — distinguishes children within a folder listing. */
  contentType: string
  version: number
  [key: string]: unknown
}

/** A folder read (GET /v1/monitors/{id}), including its immediate children. */
export interface MonitorsLibraryFolderResponse {
  id: string
  name: string
  contentType: string
  children?: MonitorsLibraryChild[]
  [key: string]: unknown
}

/** The full Monitor body (GET /v1/monitors/{id} for a Monitor-typed item). */
export interface Monitor {
  id?: string
  type: 'MonitorsLibraryMonitor'
  name: string
  description?: string
  parentId?: string
  version?: number
  monitorType: string
  queries: unknown[]
  triggers: unknown[]
  notifications?: unknown[]
  isDisabled?: boolean
  evaluationDelay?: string
  alertName?: string
  notificationGroupFields?: string[]
  groupNotifications?: boolean
  timeZone?: string
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

/**
 * Parse a canvas JSON-blob field (queries/triggers/notifications) into an
 * array. Accepts a JSON string, an already-parsed array (some canvas
 * `textarea` fields may arrive pre-parsed depending on platform storage), or
 * blank (→ []). Throws a descriptive error on malformed JSON so validate.ts
 * can surface it clearly rather than deploy failing with a raw parser error.
 */
export function parseJsonArray(value: unknown, fieldLabel: string): unknown[] {
  if (value === '' || value === null || value === undefined) return []
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) throw new Error(`${fieldLabel} must be a JSON array`)
    return parsed
  }
  throw new Error(`${fieldLabel} must be a JSON array`)
}

/** Same as parseJsonArray but returns null instead of throwing, for best-effort read paths. */
export function tryParseJsonArray(value: unknown, fieldLabel: string): unknown[] | null {
  try {
    return parseJsonArray(value, fieldLabel)
  } catch {
    return null
  }
}

/** Find a Monitor-type child by name (case-insensitive, trimmed) within a folder's children. */
export function findMonitorChild(children: MonitorsLibraryChild[] | undefined, name: string): MonitorsLibraryChild | null {
  const n = name.trim().toLowerCase()
  if (!n || !children) return null
  return children.find((c) => c.contentType === 'Monitor' && s(c.name).toLowerCase() === n) ?? null
}

/** Build the create-request body (POST /v1/monitors?parentId=...). */
export function buildMonitorCreateBody(fields: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    type: 'MonitorsLibraryMonitor',
    name: s(fields.name),
    description: s(fields.description),
    monitorType: s(fields.monitorType) || 'Logs',
    queries: parseJsonArray(fields.queries, 'Queries'),
    triggers: parseJsonArray(fields.triggers, 'Triggers'),
    isDisabled: normalizeBool(fields.isDisabled),
    groupNotifications: normalizeBool(fields.groupNotifications),
  }
  const notifications = parseJsonArray(fields.notifications, 'Notifications')
  if (notifications.length) body.notifications = notifications
  if (s(fields.evaluationDelay)) body.evaluationDelay = s(fields.evaluationDelay)
  if (s(fields.alertName)) body.alertName = s(fields.alertName)
  if (s(fields.timeZone)) body.timeZone = s(fields.timeZone)
  const groupFields = Array.isArray(fields.notificationGroupFields)
    ? (fields.notificationGroupFields as unknown[]).map((v) => s(v)).filter(Boolean)
    : []
  if (groupFields.length) body.notificationGroupFields = groupFields
  return body
}

/** Build the update-request body (PUT /v1/monitors/<id>) — requires the CURRENT live `version`. */
export function buildMonitorUpdateBody(fields: Record<string, unknown>, currentVersion: number): Record<string, unknown> {
  return { ...buildMonitorCreateBody(fields), version: currentVersion }
}
