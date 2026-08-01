// Shared helpers for the PagerDuty Schedules config type
// (validate + deploy + rollback + drift + health).
//
// A PagerDuty on-call schedule lives at /schedules and is keyed for reconciliation
// by its `name` (PagerDuty assigns the server id). A schedule has a `time_zone`
// (IANA name, required on create) and one or more `schedule_layers` describing the
// rotation. Each layer carries a start, a rotation anchor + turn length, and the
// ordered users who rotate through it.
//
// Request/response shapes follow the PagerDuty REST API v2 (verified against
// PagerDuty's API reference and the official go-pagerduty client, schedule.go):
//   list:   GET    /schedules          -> { schedules: [...] }
//   create: POST   /schedules          <- { schedule: {...} }
//   get:    GET    /schedules/{id}      -> { schedule: {...} }
//   update: PUT    /schedules/{id}      <- { schedule: {...} }
//   delete: DELETE /schedules/{id}
//
// A schedule layer's users are wrapped: [{ "user": { "id": "P…", "type": "user_reference" } }]
// (go-pagerduty UserReference{ User APIObject }).
//
// Docs: https://developer.pagerduty.com/api-reference/846ecf84402bb-create-a-schedule
//       https://github.com/PagerDuty/go-pagerduty/blob/master/schedule.go

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

/** One user in a schedule layer's rotation — { user: { id, type } }. */
export interface ScheduleLayerUser {
  user: { id: string; type?: string }
}

/** One rotation layer of a schedule. */
export interface ScheduleLayer {
  name?: string
  start: string
  end?: string
  rotation_virtual_start: string
  rotation_turn_length_seconds: number
  users: ScheduleLayerUser[]
  restrictions?: unknown[]
}

/** A schedule as returned by GET /schedules. */
export interface LiveSchedule {
  id?: string
  type?: string
  name?: string
  time_zone?: string
  description?: string
  schedule_layers?: ScheduleLayer[]
}

/** One canvas item, normalized to the fields this config type manages. */
export interface ScheduleSpec {
  itemName: string
  name: string
  timeZone: string
  /** Raw JSON text for the schedule_layers array (required, non-empty array). */
  layersJson: string
}

/**
 * Result of parsing the schedule_layers JSON. NOT a discriminated union — the
 * platform's handler loader does not narrow `{ ok:true } | { ok:false }`, so
 * `layers` and `error` are always-present nullable fields.
 */
export interface LayersParseResult {
  layers: ScheduleLayer[] | null
  error: string | null
}

/**
 * Parse + shallow-validate the schedule_layers JSON. Returns the typed layers on
 * success, or a human-readable `error` describing the first problem. A blank input
 * is an error (a schedule needs at least one layer to be created).
 */
export function parseScheduleLayers(raw: string | undefined): LayersParseResult {
  const text = (raw ?? '').trim()
  if (!text) return { layers: null, error: 'is required (a non-empty JSON array of rotation layers)' }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { layers: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (!Array.isArray(parsed)) return { layers: null, error: 'must be a JSON array of rotation layers' }
  if (parsed.length === 0) return { layers: null, error: 'must contain at least one rotation layer' }

  const layers: ScheduleLayer[] = []
  for (let i = 0; i < parsed.length; i++) {
    const layer = parsed[i] as Record<string, unknown>
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) {
      return { layers: null, error: `layer ${i + 1} must be an object` }
    }
    const start = typeof layer.start === 'string' ? layer.start.trim() : ''
    if (!start) return { layers: null, error: `layer ${i + 1} needs a "start" timestamp (ISO 8601)` }
    const rvs = typeof layer.rotation_virtual_start === 'string' ? layer.rotation_virtual_start.trim() : ''
    if (!rvs) return { layers: null, error: `layer ${i + 1} needs a "rotation_virtual_start" timestamp (ISO 8601)` }
    const turn = layer.rotation_turn_length_seconds
    if (typeof turn !== 'number' || !Number.isFinite(turn) || turn < 1) {
      return { layers: null, error: `layer ${i + 1} needs a positive numeric "rotation_turn_length_seconds"` }
    }
    const users = layer.users
    if (!Array.isArray(users) || users.length === 0) {
      return { layers: null, error: `layer ${i + 1} needs a non-empty "users" array` }
    }
    const cleanUsers: ScheduleLayerUser[] = []
    for (let u = 0; u < users.length; u++) {
      const entry = users[u] as Record<string, unknown>
      const userObj = entry?.user as Record<string, unknown> | undefined
      const id = typeof userObj?.id === 'string' ? userObj.id.trim() : ''
      if (!id) {
        return {
          layers: null,
          error: `layer ${i + 1} user ${u + 1} must be shaped { "user": { "id": "<PagerDuty user id>", "type": "user_reference" } }`,
        }
      }
      const type = typeof userObj?.type === 'string' && userObj.type.trim() ? userObj.type.trim() : 'user_reference'
      cleanUsers.push({ user: { id, type } })
    }
    const clean: ScheduleLayer = {
      start,
      rotation_virtual_start: rvs,
      rotation_turn_length_seconds: turn,
      users: cleanUsers,
    }
    if (typeof layer.name === 'string' && layer.name.trim()) clean.name = layer.name.trim()
    if (typeof layer.end === 'string' && layer.end.trim()) clean.end = layer.end.trim()
    if (Array.isArray(layer.restrictions)) clean.restrictions = layer.restrictions
    layers.push(clean)
  }
  return { layers, error: null }
}

/** Each canvas item describes one schedule. */
export function extractScheduleSpecs(canvas: CanvasSnapshot): ScheduleSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      itemName: item.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      timeZone: typeof fields.time_zone === 'string' ? fields.time_zone.trim() : '',
      layersJson: typeof fields.schedule_layers === 'string' ? fields.schedule_layers : '',
    }
  })
}

/**
 * Build the request body for POST/PUT /schedules. Wrapped in a { schedule: {...} }
 * envelope by callers. `type` is set explicitly so the API resolves the resource
 * unambiguously.
 */
export function buildScheduleBody(spec: ScheduleSpec, layers: ScheduleLayer[]): LiveSchedule {
  return {
    type: 'schedule',
    name: spec.name,
    time_zone: spec.timeZone,
    schedule_layers: layers,
  }
}

/** Find a live schedule by name (case-insensitive — the reconciliation identity). */
export function findSchedule(schedules: LiveSchedule[], name: string): LiveSchedule | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return schedules.find((s) => String(s.name ?? '').trim().toLowerCase() === n) ?? null
}
