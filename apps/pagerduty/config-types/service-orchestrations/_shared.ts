// Shared helpers for the PagerDuty Service Orchestrations config type
// (validate + deploy + rollback + drift + health).
//
// A Service Orchestration is the set of Event Rules attached to a single,
// existing PagerDuty Service — a SINGLETON per service (there is no separate id
// or create/delete of "the resource" itself, only a whole-content replace), keyed
// for reconciliation by the Service's `name` (resolved to its id at deploy). Its
// wire shape is identical to the Router/Global/Unrouted paths of an Event
// Orchestration:
//   { "orchestration_path": { "sets": [ { "id", "rules"? } ], "catch_all": { "actions" } } }
// plus a separate boolean flag for whether it is the service's active processing
// path.
//
// `sets` and `catch_all` are intentionally treated as OPAQUE, pass-through JSON —
// same reasoning as the event-orchestrations config type's Router/Global/Unrouted
// paths (see that config type's _shared.ts for the full rationale).
//
// Request/response shapes follow the PagerDuty REST API v2 (verified against the
// official OpenAPI v3 spec):
//   read/write: GET/PUT /event_orchestrations/services/{service_id}          <-> { orchestration_path: {...} }
//   active:     GET/PUT /event_orchestrations/services/{service_id}/active   <-> { active: boolean }
//   services:   GET /services -> { services: [...] } (resolves the `service` field by name)
//
// A service with NO Service Orchestration configured yet returns 404 on the
// content GET — this is a normal "nothing here yet" state, not an error; deploy
// and rollback both treat it as PagerDuty's own empty baseline
// ({ sets: [{ id: "start", rules: [] }], catch_all: { actions: {} } }).
//
// Docs: https://developer.pagerduty.com/api-reference/9d3e5081cc463-get-the-router-for-an-event-orchestration
//       https://support.pagerduty.com/docs/event-orchestration#service-orchestrations

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

/** One rule set within a Service Orchestration's path — opaque beyond `id`/`rules`. */
export interface OrchestrationSet {
  id: string
  rules?: unknown[]
  [key: string]: unknown
}

/** The catch_all block of a Service Orchestration's path — opaque beyond requiring `actions`. */
export interface OrchestrationCatchAll {
  actions: Record<string, unknown>
  [key: string]: unknown
}

/** Body of a Service Orchestration path, sent/received under `orchestration_path`. */
export interface OrchestrationPathBody {
  sets: OrchestrationSet[]
  catch_all: OrchestrationCatchAll
}

/** A Service Orchestration path as returned by GET — the same fields plus server metadata. */
export interface LiveOrchestrationPath extends Partial<OrchestrationPathBody> {
  type?: string
  parent?: { id?: string; type?: string; self?: string }
  version?: string
}

/** The empty baseline PagerDuty implies for a service with no orchestration configured. */
export const EMPTY_ORCHESTRATION_PATH: OrchestrationPathBody = {
  sets: [{ id: 'start', rules: [] }],
  catch_all: { actions: {} },
}

/** Default catch_all used whenever the optional catch_all field is left blank. */
export const DEFAULT_CATCH_ALL_JSON = '{"actions":{}}'

/**
 * Result of parsing a Service Orchestration's `sets` JSON. NOT a discriminated
 * union — the platform's handler loader does not narrow `{ ok:true } | { ok:false }`,
 * so `sets` and `error` are always-present nullable fields.
 */
export interface SetsParseResult {
  sets: OrchestrationSet[] | null
  error: string | null
}

/** Result of parsing a Service Orchestration's `catch_all` JSON. Same non-discriminated shape. */
export interface CatchAllParseResult {
  catchAll: OrchestrationCatchAll | null
  error: string | null
}

/** A service as returned by GET /services (only the fields this config type needs). */
export interface LiveServiceRef {
  id?: string
  name?: string
}

/** One canvas item, normalized to the fields this config type manages. */
export interface ServiceOrchestrationSpec {
  itemName: string
  /** The NAME of the PagerDuty Service this orchestration belongs to; resolved to an id at deploy. */
  service: string
  active: boolean
  setsJson: string
  catchAllJson: string
}

/** Each canvas item describes one service's Service Orchestration. */
export function extractServiceOrchestrationSpecs(canvas: CanvasSnapshot): ServiceOrchestrationSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      itemName: item.name,
      service: typeof fields.service === 'string' ? fields.service.trim() : '',
      active: typeof fields.active === 'boolean' ? fields.active : true,
      setsJson: typeof fields.sets === 'string' ? fields.sets : '',
      catchAllJson: typeof fields.catch_all === 'string' ? fields.catch_all : '',
    }
  })
}

/**
 * Parse + shallow-validate the `sets` JSON. Returns the typed sets on success, or
 * a human-readable `error` describing the first problem. A blank input is an
 * error (sets are required and must be a non-empty array).
 */
export function parseOrchestrationSets(raw: string | undefined): SetsParseResult {
  const text = (raw ?? '').trim()
  if (!text) return { sets: null, error: 'is required (a non-empty JSON array of sets)' }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { sets: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (!Array.isArray(parsed)) return { sets: null, error: 'must be a JSON array of sets' }
  if (parsed.length === 0) return { sets: null, error: 'must contain at least one set' }

  const sets: OrchestrationSet[] = []
  for (let i = 0; i < parsed.length; i++) {
    const set = parsed[i] as Record<string, unknown>
    if (!set || typeof set !== 'object' || Array.isArray(set)) {
      return { sets: null, error: `set ${i + 1} must be an object` }
    }
    const id = typeof set.id === 'string' ? set.id.trim() : ''
    if (!id) return { sets: null, error: `set ${i + 1} needs a non-empty "id"` }
    if (set.rules !== undefined) {
      if (!Array.isArray(set.rules)) {
        return { sets: null, error: `set "${id}" (set ${i + 1}) "rules" must be an array when present` }
      }
      for (let r = 0; r < set.rules.length; r++) {
        const rule = set.rules[r]
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
          return { sets: null, error: `set "${id}" rule ${r + 1} must be an object` }
        }
      }
    }
    sets.push({ ...set, id } as OrchestrationSet)
  }
  return { sets, error: null }
}

/**
 * Parse + shallow-validate the `catch_all` JSON. Blank input falls back to
 * DEFAULT_CATCH_ALL_JSON (`{"actions":{}}`) rather than erroring.
 */
export function parseCatchAll(raw: string | undefined): CatchAllParseResult {
  const text = (raw ?? '').trim() || DEFAULT_CATCH_ALL_JSON

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { catchAll: null, error: `must be valid JSON (${err instanceof Error ? err.message : 'parse error'})` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { catchAll: null, error: 'must be a JSON object' }
  }
  const obj = parsed as Record<string, unknown>
  if (!obj.actions || typeof obj.actions !== 'object' || Array.isArray(obj.actions)) {
    return { catchAll: null, error: 'must include an "actions" object' }
  }
  return { catchAll: obj as OrchestrationCatchAll, error: null }
}

/** Build the { orchestration_path: {...} } body sent to PUT .../services/{service_id}. */
export function buildOrchestrationPathBody(
  sets: OrchestrationSet[],
  catchAll: OrchestrationCatchAll,
): { orchestration_path: OrchestrationPathBody } {
  return { orchestration_path: { sets, catch_all: catchAll } }
}

/** Resolve a Service NAME to its id (case-insensitive). */
export function findServiceId(services: LiveServiceRef[], name: string): string | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  const match = services.find((s) => String(s.name ?? '').trim().toLowerCase() === n)
  return match?.id ?? null
}
