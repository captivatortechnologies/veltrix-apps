// Shared shapes + body builders for the Tanium Sensors config type.
//
// A Tanium sensor (GET /api/v2/sensors, GET /api/v2/sensors/by-name/{name}) is a
// named script that collects data from endpoints for use in questions. Its
// response shape — name, description, category, max_age_seconds, a
// content_set reference, a per-platform `queries[]` list (platform + script +
// script_type), and `parameters[]` (key + default_value) — is documented in
// Tanium's own published Platform REST API reference (developer.tanium.com,
// mirrored at https://github.com/api-evangelist/tanium/blob/main/openapi/tanium-sensors-api-openapi.yml).
//
// VERIFY AGAINST A LIVE TANIUM (FLAGGED): that reference documents ONLY
// `GET /api/v2/sensors` and `GET /api/v2/sensors/by-name/{name}` — the same is
// true of Tanium's public integrations (Cortex XSOAR `Tanium_v2`, Splunk SOAR
// `taniumrest`), which read sensors by name but never create one. POST create
// and DELETE below follow the SAME generic named-entity REST v2 convention
// already exercised by packages and saved questions (this app's shared
// lib/taniumRestEntity.ts groups sensors into that family), but neither verb is
// independently confirmed for sensors by a public integration. Verify the
// `queries[].script_type` enum and the create body shape against your Tanium
// before relying on this in production.

import type { NamedEntity } from '../../lib/taniumRestEntity'
import { keyValueMap } from '../../lib/canvasValues'

/** Tanium's REST v2 collection name for this object. */
export const SENSORS_RESOURCE = 'sensors'

/** One platform-specific script a sensor runs (`queries[]` in the Sensor schema). */
export interface TaniumSensorQuery {
  platform?: string
  script?: string
  script_type?: string
}

/** One `{ key, default_value }` sensor parameter. */
export interface TaniumSensorParameter {
  key?: string
  default_value?: string
}

/** One sensor as returned by /api/v2/sensors (usually `{ data: {...} }`). */
export interface TaniumSensor extends NamedEntity {
  description?: string
  category?: string
  max_age_seconds?: number
  queries?: TaniumSensorQuery[]
  parameters?: TaniumSensorParameter[]
}

/** The body POST /api/v2/sensors accepts for a sensor. */
export interface TaniumSensorBody {
  name: string
  description?: string
  category?: string
  max_age_seconds?: number
  queries: TaniumSensorQuery[]
  parameters?: TaniumSensorParameter[]
}

/** Non-exhaustive but common Tanium sensor script types (VBScript is the historical default). */
export const SENSOR_SCRIPT_TYPES = ['VBScript', 'PowerShell', 'Bash', 'Python', 'CommandLine'] as const

/** Non-exhaustive but common Tanium sensor target platforms. */
export const SENSOR_PLATFORMS = ['Windows', 'Linux', 'Mac', 'Solaris', 'AIX'] as const

/** Parse an optional non-negative-integer field (a canvas number or its string). */
export function parseNonNegativeInt(raw: unknown): { value?: number; error?: string } {
  const s = String(raw ?? '').trim()
  if (!s) return { value: undefined }
  if (!/^\d+$/.test(s)) return { error: 'must be a non-negative whole number of seconds' }
  return { value: Number(s) }
}

/**
 * Parse the optional "Additional Queries (advanced)" JSON field — extra
 * per-platform `{ platform, script, script_type }` entries appended after the
 * primary query, for a sensor that runs a different script per platform. Empty →
 * no extra entries. Invalid JSON, a non-array root, or an entry missing any of
 * the three required keys is reported as an error.
 */
export function parseAdditionalQueries(raw: unknown): { value: TaniumSensorQuery[]; error?: string } {
  const s = String(raw ?? '').trim()
  if (!s) return { value: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(s)
  } catch (e) {
    return { value: [], error: `Additional queries is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }
  if (!Array.isArray(parsed)) {
    return { value: [], error: 'Additional queries must be a JSON array of { platform, script, script_type } objects.' }
  }
  const queries: TaniumSensorQuery[] = []
  for (const [i, entry] of parsed.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { value: [], error: `Additional queries[${i}] must be an object with platform, script and script_type.` }
    }
    const e = entry as Record<string, unknown>
    const platform = String(e.platform ?? '').trim()
    const script = String(e.script ?? '').trim()
    const scriptType = String(e.script_type ?? '').trim()
    if (!platform || !script || !scriptType) {
      return { value: [], error: `Additional queries[${i}] is missing platform, script or script_type.` }
    }
    queries.push({ platform, script, script_type: scriptType })
  }
  return { value: queries }
}

/** Build the `parameters[]` list from the canvas `keyvalue` field (key → default_value). */
export function parametersOf(fields: Record<string, unknown>): TaniumSensorParameter[] {
  return Object.entries(keyValueMap(fields.parameters)).map(([key, default_value]) => ({ key, default_value }))
}

/**
 * Build the primary query from the canvas platform / scriptType / script fields,
 * then append any parsed "additional queries" (multi-platform sensors).
 */
export function queriesOf(fields: Record<string, unknown>): TaniumSensorQuery[] {
  const primary: TaniumSensorQuery = {
    platform: String(fields.platform ?? '').trim(),
    script: String(fields.script ?? '').trim(),
    script_type: String(fields.scriptType ?? '').trim(),
  }
  const additional = parseAdditionalQueries(fields.additionalQueriesJson).value
  return [primary, ...additional]
}

/** Build the sensor body from canvas fields. Optional fields are sent only when set. */
export function buildSensorBody(fields: Record<string, unknown>): TaniumSensorBody {
  const body: TaniumSensorBody = {
    name: String(fields.name ?? '').trim(),
    queries: queriesOf(fields),
  }
  const description = String(fields.description ?? '').trim()
  if (description) body.description = description

  const category = String(fields.category ?? '').trim()
  if (category) body.category = category

  const maxAge = parseNonNegativeInt(fields.maxAgeSeconds)
  if (maxAge.value !== undefined) body.max_age_seconds = maxAge.value

  const parameters = parametersOf(fields)
  if (parameters.length > 0) body.parameters = parameters

  return body
}

/** The primary (first) query a prior sensor carries, for drift comparison. */
export function primaryQueryOf(sensor: TaniumSensor | null | undefined): TaniumSensorQuery {
  return sensor?.queries?.[0] ?? {}
}

/** Rebuild a POST body from a captured prior sensor for rollback. */
export function restoreSensorBody(prior: TaniumSensor): TaniumSensorBody {
  const body: TaniumSensorBody = {
    name: String(prior.name ?? '').trim(),
    queries: Array.isArray(prior.queries) && prior.queries.length > 0 ? prior.queries : [{}],
  }
  if (prior.description) body.description = prior.description
  if (prior.category) body.category = prior.category
  if (prior.max_age_seconds !== undefined) body.max_age_seconds = prior.max_age_seconds
  if (Array.isArray(prior.parameters) && prior.parameters.length > 0) body.parameters = prior.parameters
  return body
}
