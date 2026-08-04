// Shared helpers for the Auth0 Log Streams config type (deploy + rollback +
// drift).
//
// Log streams deliver tenant logs to an external sink — GET/POST
// /api/v2/log-streams and GET/PATCH/DELETE /api/v2/log-streams/{id}. The
// Management API keys a log stream on the server-assigned `id`, so this
// config type upserts by stream NAME (Auth0 enforces a unique name per
// tenant). `name` and `type` (the sink kind) are set at creation and are NOT
// changed on update — a sink's type cannot be swapped in place, so the PATCH
// body omits both.
//
// `sink` is a type-dependent object, authored as free-form JSON with the raw
// Management API's camelCase field names (Terraform's provider renames these
// to snake_case on its own side — this app talks to the REST API directly, so
// it uses the API's own names). It is authored and sent whole on every deploy
// (never partial-merged), matching connections' `options`. Secret-bearing
// sink keys are returned masked by Auth0, so they are excluded from drift
// comparison and from the rollback restore body (via `stripSecretKeys`) to
// avoid overwriting a live secret with its mask — the live deploy body itself
// still carries the operator's real secret values, since the sink otherwise
// could not authenticate.
//
// Verified against the official Auth0 Management API v2 (Log Streams):
//   https://auth0.com/docs/api/management/v2/log-streams/post-log-streams
//   https://auth0.com/docs/api/management/v2/log-streams/patch-log-streams-by-id

import { parseJsonObject, readOptionalString, readString, stripSecretKeys } from '../../lib/fields'

/** Sink types Auth0 accepts for a log stream. */
export const LOG_STREAM_TYPES = new Set([
  'http',
  'eventbridge',
  'eventgrid',
  'datadog',
  'splunk',
  'sumo',
  'mixpanel',
  'segment',
])

/** Delivery statuses Auth0 accepts for a log stream. */
export const LOG_STREAM_STATUSES = new Set(['active', 'paused', 'suspended'])

/** One log stream as returned by the Management API. */
export interface Auth0LogStream {
  id?: string
  name?: string
  type?: string
  status?: string
  sink?: Record<string, unknown>
  filters?: Array<Record<string, unknown>>
  [key: string]: unknown
}

/** The create body — name + type are only sent when creating (immutable thereafter). */
export interface LogStreamCreateBody {
  name: string
  type: string
  sink: Record<string, unknown>
  filters?: Array<Record<string, unknown>>
  status?: string
}

/** The update body — name and type are omitted (immutable). `sink` is always sent whole. */
export interface LogStreamUpdateBody {
  sink: Record<string, unknown>
  filters?: Array<Record<string, unknown>>
  status?: string
}

/**
 * Read a `textarea` field holding a JSON array. Mirrors `parseJsonObject` in
 * lib/fields.ts but for the array shape `filters` is authored in. Returns a
 * discriminated result so callers can surface a precise validation error.
 */
export function parseJsonArray(value: unknown): { ok: true; value: unknown[] } | { ok: false; error: string } {
  if (value == null) return { ok: true, value: [] }
  if (Array.isArray(value)) return { ok: true, value }
  if (typeof value === 'object') return { ok: false, error: 'must be a JSON array, not an object' }
  if (typeof value !== 'string') return { ok: false, error: 'must be a JSON array' }
  const trimmed = value.trim()
  if (!trimmed) return { ok: true, value: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid JSON' }
  }
  if (!Array.isArray(parsed)) return { ok: false, error: 'must be a JSON array' }
  return { ok: true, value: parsed }
}

/** Find a live log stream by name (case-sensitive, trimmed) — the upsert identity. */
export function findLogStreamByName(list: Auth0LogStream[], name: string): Auth0LogStream | null {
  const n = name.trim()
  if (!n) return null
  return list.find((s) => String(s.name ?? '').trim() === n) ?? null
}

function sinkFromFields(fields: Record<string, unknown>): Record<string, unknown> {
  const parsed = parseJsonObject(fields.sink)
  return parsed.ok ? parsed.value : {}
}

function filtersFromFields(fields: Record<string, unknown>): Array<Record<string, unknown>> {
  const parsed = parseJsonArray(fields.filters)
  if (!parsed.ok) return []
  return parsed.value.filter((v): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v))
}

/** Build the create body from canvas fields (name + type included; sink sent whole). */
export function buildLogStreamCreateBody(fields: Record<string, unknown>): LogStreamCreateBody {
  const body: LogStreamCreateBody = {
    name: readString(fields.name),
    type: readString(fields.type),
    sink: sinkFromFields(fields),
  }
  const filters = filtersFromFields(fields)
  if (filters.length > 0) body.filters = filters
  const status = readOptionalString(fields.status)
  if (status) body.status = status
  return body
}

/** Build the update body from canvas fields (name + type omitted — immutable; sink sent whole). */
export function buildLogStreamUpdateBody(fields: Record<string, unknown>): LogStreamUpdateBody {
  const body: LogStreamUpdateBody = { sink: sinkFromFields(fields) }
  const filters = filtersFromFields(fields)
  if (filters.length > 0) body.filters = filters
  const status = readOptionalString(fields.status)
  if (status) body.status = status
  return body
}

/**
 * Capture the prior managed state of a live log stream for rollback. Secret
 * sink keys are stripped so a restore never rewrites a live secret with
 * Auth0's mask.
 */
export function snapshotLogStream(stream: Auth0LogStream): LogStreamUpdateBody {
  const body: LogStreamUpdateBody = {
    sink: stripSecretKeys(stream.sink ?? {}),
    filters: Array.isArray(stream.filters) ? stream.filters : [],
  }
  if (typeof stream.status === 'string' && stream.status) body.status = stream.status
  return body
}
