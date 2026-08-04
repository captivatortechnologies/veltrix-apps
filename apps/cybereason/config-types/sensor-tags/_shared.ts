// Shared helpers for the Cybereason Sensor Tags config type
// (validate + deploy + rollback + drift + tests).
//
// Cybereason lets an admin tag a sensor (machine) with department / location /
// device type / critical-asset / custom-tags metadata, independent of sensor
// GROUPS (config-types/sensor-groups) which assign a policy. The authoring
// identity is the sensor's stable `pylumId`.
//
// CONFIRMED against forensic-security/cybereason (async Python SDK):
//   write: POST /rest/tagging/process_tags  (sensors.py `set_sensor_tags`) — body
//     `{ entities: { <pylumId>: { tags: { <wireTagName>: { operation: 'SET'|
//     'REMOVE', value? } }, entityType: 'MACHINE' } } }`; response
//     `{ entities: { <pylumId>: { results: { <tagName>: { success, operation,
//     oldValue, ... } } } } }`. The wire tag NAMES are literal strings WITH
//     spaces ("device type", "critical asset", "custom tags") — reproduced
//     verbatim below, not camelCased.
//   read: POST /rest/sensors/query (sensors.py `get_sensors`) — filter by
//     `pylumId`; each returned sensor row carries `department`, `location`,
//     `deviceType`, `criticalAsset`, `customTags` fields DIRECTLY (camelCase, no
//     spaces — an asymmetry with the write-side wire names, handled by
//     TAG_FIELDS below). The exact field set is drawn from a REAL, live-tenant-
//     recorded JSON Schema (tests/schemas/sensors.yaml `sensors`, checked by
//     `test_get_sensors` against an actual tenant in that repo's integration
//     tests) — not guessed from documentation.
// The 100-character cap on `customTags` mirrors the SDK's own client-side
// validation ("The maximum length for the 'custom tags' tag is 100 characters").
export const TAGGING_ENDPOINT = '/rest/tagging/process_tags'
export const SENSORS_QUERY_ENDPOINT = '/rest/sensors/query'

export type TagValueType = 'string' | 'boolean'

export interface TagFieldSpec {
  /** Canvas field key. */
  key: 'department' | 'location' | 'deviceType' | 'criticalAsset' | 'customTags'
  /** Field name on a GET/POST sensors/query row. */
  readKey: string
  /** Wire tag name sent to / read back from POST /rest/tagging/process_tags. */
  wireKey: string
  type: TagValueType
}

export const TAG_FIELDS: TagFieldSpec[] = [
  { key: 'department', readKey: 'department', wireKey: 'department', type: 'string' },
  { key: 'location', readKey: 'location', wireKey: 'location', type: 'string' },
  { key: 'deviceType', readKey: 'deviceType', wireKey: 'device type', type: 'string' },
  { key: 'criticalAsset', readKey: 'criticalAsset', wireKey: 'critical asset', type: 'boolean' },
  { key: 'customTags', readKey: 'customTags', wireKey: 'custom tags', type: 'string' },
]

export const CUSTOM_TAGS_MAX_LENGTH = 100

/** Canvas fields authored for one sensor's tag set. */
export interface TagFields {
  pylumId?: unknown
  department?: unknown
  location?: unknown
  deviceType?: unknown
  criticalAsset?: unknown
  customTags?: unknown
}

/** One tagging operation as sent on the wire. */
export type TagOp = { operation: 'SET'; value: string | boolean } | { operation: 'REMOVE' }

/** A snapshot of a sensor's current tag values, keyed by canvas field key. */
export type TagSnapshot = Partial<Record<TagFieldSpec['key'], string | boolean | null>>

/** Normalize the tri-state `criticalAsset` canvas value: '' (unset) | 'true' | 'false'. */
export function normalizeCriticalAsset(value: unknown): '' | 'true' | 'false' {
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'true' || s === 'false' ? s : ''
}

/**
 * Build the `tags` object for POST /rest/tagging/process_tags from canvas
 * fields: a field left blank sends `REMOVE` (clears that tag); a field with a
 * value sends `SET`. Mirrors the SDK's own None → REMOVE / value → SET model.
 */
export function buildTagOps(fields: TagFields): Record<string, TagOp> {
  const ops: Record<string, TagOp> = {}
  for (const spec of TAG_FIELDS) {
    if (spec.type === 'boolean') {
      const tri = normalizeCriticalAsset(fields[spec.key])
      ops[spec.wireKey] = tri === '' ? { operation: 'REMOVE' } : { operation: 'SET', value: tri === 'true' }
    } else {
      const raw = String(fields[spec.key] ?? '').trim()
      ops[spec.wireKey] = raw ? { operation: 'SET', value: raw } : { operation: 'REMOVE' }
    }
  }
  return ops
}

/** Build the POST /rest/tagging/process_tags request body for one sensor. */
export function buildProcessTagsBody(pylumId: string, ops: Record<string, TagOp>): Record<string, unknown> {
  return { entities: { [pylumId]: { tags: ops, entityType: 'MACHINE' } } }
}

interface TagOpResult {
  success?: boolean
  operation?: string
  oldValue?: unknown
  [key: string]: unknown
}

/**
 * Parse the process_tags response for one pylumId and throw if any tag
 * operation genuinely failed. Mirrors the SDK's own tolerance: a failed REMOVE
 * of a tag that had no prior value (`oldValue === ''`) is not a real failure.
 */
export function assertTagsApplied(body: string, pylumId: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error(`process_tags response was not valid JSON: ${body.slice(0, 200)}`)
  }
  const results = (parsed as Record<string, unknown>)?.entities as Record<string, { results?: Record<string, TagOpResult> }> | undefined
  const perTag = results?.[pylumId]?.results ?? {}
  const failures = Object.entries(perTag).filter(
    ([, r]) => r?.success === false && !(r?.operation === 'REMOVE' && r?.oldValue === ''),
  )
  if (failures.length > 0) {
    const detail = failures.map(([tag, r]) => `${tag}: ${JSON.stringify(r)}`).join('; ')
    throw new Error(`process_tags reported failure for pylumId ${pylumId}: ${detail}`)
  }
}

/** Parse the sensors/query response into raw sensor rows. Tolerates a `{ sensors }` envelope. */
export function sensorsFromResponse(body: string): Array<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  if (Array.isArray(parsed)) return parsed as Array<Record<string, unknown>>
  if (parsed && typeof parsed === 'object') {
    const inner = (parsed as Record<string, unknown>).sensors
    if (Array.isArray(inner)) return inner as Array<Record<string, unknown>>
  }
  return []
}

/** Build the sensors/query POST body filtered to a single pylumId. */
export function buildPylumIdQuery(pylumId: string): Record<string, unknown> {
  return {
    filters: [{ fieldName: 'pylumId', operator: 'Equals', values: [pylumId] }],
    limit: 1,
    offset: 0,
    sortDirection: 'ASC',
  }
}

/** Extract the current tag snapshot for the first sensor row matching `pylumId`. */
export function extractTagSnapshot(rows: Array<Record<string, unknown>>, pylumId: string): TagSnapshot | null {
  const row = rows.find((r) => String(r.pylumId ?? '') === pylumId)
  if (!row) return null
  const snapshot: TagSnapshot = {}
  for (const spec of TAG_FIELDS) {
    const value = row[spec.readKey]
    if (spec.type === 'boolean') {
      snapshot[spec.key] = typeof value === 'boolean' ? value : null
    } else {
      snapshot[spec.key] = typeof value === 'string' && value !== '' ? value : null
    }
  }
  return snapshot
}

/** Build tag ops from a prior snapshot — used by rollback to restore or clear each tag. */
export function buildTagOpsFromSnapshot(snapshot: TagSnapshot | null): Record<string, TagOp> {
  const ops: Record<string, TagOp> = {}
  for (const spec of TAG_FIELDS) {
    const value = snapshot?.[spec.key] ?? null
    ops[spec.wireKey] = value === null || value === undefined ? { operation: 'REMOVE' } : { operation: 'SET', value }
  }
  return ops
}
