// Shared helpers for the PagerDuty Event Orchestrations config type
// (validate + deploy + rollback + drift + health).
//
// A PagerDuty Event Orchestration lives at /event_orchestrations and is keyed for
// reconciliation by its `name` (PagerDuty assigns the server id). Every
// orchestration has three orchestration PATHS, each carrying its own ordered list
// of rule sets and a catch_all:
//   - Router (required): the single mandatory entry point. Evaluates starting
//     from a "start" set and routes events to a Service.
//   - Global (optional): rules applied to every event before it reaches a Service.
//   - Unrouted (optional): rules applied to events the Router didn't route.
//
// All three paths share the identical wire shape:
//   { "orchestration_path": { "sets": [ { "id", "rules"? } ], "catch_all": { "actions" } } }
//
// `sets` and `catch_all` are intentionally treated as OPAQUE, pass-through JSON —
// same reasoning as escalation-policies' escalation_rules. PagerDuty's rule action
// vocabulary is large and evolving (route_to, drop_event, suppress, priority,
// escalation_policy, annotate, severity, event_action, variable[], extraction[],
// automation_action{...}, incident_custom_field_update{...}, ...), so this config
// type validates SHALLOW structure only and lets the API be the source of truth
// for anything deeper.
//
// Request/response shapes follow the PagerDuty REST API v2 (verified against the
// official OpenAPI v3 spec):
//   list:     GET    /event_orchestrations              -> { orchestrations: [...] }
//   create:   POST   /event_orchestrations              <- { orchestration: {...} }
//   update:   PUT    /event_orchestrations/{id}          <- { orchestration: {...} }
//   delete:   DELETE /event_orchestrations/{id}
//   router:   GET/PUT /event_orchestrations/{id}/router    <-> { orchestration_path: {...} }
//   global:   GET/PUT /event_orchestrations/{id}/global    <-> { orchestration_path: {...} }
//   unrouted: GET/PUT /event_orchestrations/{id}/unrouted  <-> { orchestration_path: {...} }
//   teams:    GET /teams -> { teams: [...] } (resolves the `team` field by name)
//
// Docs: https://developer.pagerduty.com/api-reference/9d3e5081cc463-get-the-router-for-an-event-orchestration
//       https://support.pagerduty.com/docs/event-orchestration

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

/** APIReference to the team that owns an orchestration; `type` is server-assigned. */
export interface TeamReference {
  id?: string
  type?: string
  self?: string
}

/** An Event Orchestration as returned by GET /event_orchestrations. */
export interface LiveEventOrchestration {
  id?: string
  type?: string
  self?: string
  name?: string
  description?: string
  team?: TeamReference | null
}

/** One rule set within an orchestration path — treated as opaque beyond `id`/`rules`. */
export interface OrchestrationSet {
  id: string
  rules?: unknown[]
  [key: string]: unknown
}

/** The catch_all block of an orchestration path — opaque beyond requiring `actions`. */
export interface OrchestrationCatchAll {
  actions: Record<string, unknown>
  [key: string]: unknown
}

/** Body of an orchestration path (Router / Global / Unrouted), sent under `orchestration_path`. */
export interface OrchestrationPathBody {
  sets: OrchestrationSet[]
  catch_all: OrchestrationCatchAll
}

/** An orchestration path as returned by GET — the same fields plus server metadata. */
export interface LiveOrchestrationPath extends Partial<OrchestrationPathBody> {
  type?: string
  parent?: { id?: string; type?: string; self?: string }
  version?: string
}

/**
 * Result of parsing an orchestration path's `sets` JSON. NOT a discriminated union
 * — the platform's handler loader does not narrow `{ ok:true } | { ok:false }`, so
 * `sets` and `error` are always-present nullable fields.
 */
export interface SetsParseResult {
  sets: OrchestrationSet[] | null
  error: string | null
}

/** Result of parsing an orchestration path's `catch_all` JSON. Same non-discriminated shape. */
export interface CatchAllParseResult {
  catchAll: OrchestrationCatchAll | null
  error: string | null
}

/** Default catch_all used whenever an optional catch_all field is left blank. */
export const DEFAULT_CATCH_ALL_JSON = '{"actions":{}}'

/** The Router's mandatory entry-point set id — PagerDuty only ever evaluates rules starting here. */
export const START_SET_ID = 'start'

/** One canvas item, normalized to the fields this config type manages. */
export interface EventOrchestrationSpec {
  itemName: string
  name: string
  description: string
  /** The NAME of the team to own this orchestration; resolved to an id at deploy. Blank = no team. */
  team: string
  routerSetsJson: string
  routerCatchAllJson: string
  /** Blank means Global is not declared, and this config type will not manage it. */
  globalSetsJson: string
  globalCatchAllJson: string
  /** Blank means Unrouted is not declared, and this config type will not manage it. */
  unroutedSetsJson: string
  unroutedCatchAllJson: string
}

/** Each canvas item describes one Event Orchestration. */
export function extractEventOrchestrationSpecs(canvas: CanvasSnapshot): EventOrchestrationSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      itemName: item.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description: typeof fields.description === 'string' ? fields.description.trim() : '',
      team: typeof fields.team === 'string' ? fields.team.trim() : '',
      routerSetsJson: typeof fields.router_sets === 'string' ? fields.router_sets : '',
      routerCatchAllJson: typeof fields.router_catch_all === 'string' ? fields.router_catch_all : '',
      globalSetsJson: typeof fields.global_sets === 'string' ? fields.global_sets : '',
      globalCatchAllJson: typeof fields.global_catch_all === 'string' ? fields.global_catch_all : '',
      unroutedSetsJson: typeof fields.unrouted_sets === 'string' ? fields.unrouted_sets : '',
      unroutedCatchAllJson: typeof fields.unrouted_catch_all === 'string' ? fields.unrouted_catch_all : '',
    }
  })
}

/**
 * Parse + shallow-validate an orchestration path's `sets` JSON. Returns the typed
 * sets on success, or a human-readable `error` describing the first problem. A
 * blank input is an error — callers only invoke this once a field is known to be
 * declared; Global/Unrouted skip this call entirely when left blank.
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
 * Parse + shallow-validate an orchestration path's `catch_all` JSON. Blank input
 * falls back to DEFAULT_CATCH_ALL_JSON (`{"actions":{}}`) rather than erroring —
 * catch_all is always optional.
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

/** Whether a parsed sets array includes the mandatory "start" set id. */
export function hasStartSet(sets: OrchestrationSet[]): boolean {
  return sets.some((s) => s.id === START_SET_ID)
}

/**
 * Build the request body for POST/PUT /event_orchestrations. Wrapped in an
 * `{ orchestration: {...} }` envelope by callers. `team` is sent as a bare
 * `{ id }` reference — the API documents `team.type` as server-assigned and
 * read-only, so it is never sent on write.
 */
export function buildOrchestrationBody(spec: EventOrchestrationSpec, teamId: string | undefined): LiveEventOrchestration {
  const body: LiveEventOrchestration = { name: spec.name }
  if (spec.description) body.description = spec.description
  if (teamId) body.team = { id: teamId }
  return body
}

/** Build the { orchestration_path: {...} } body shared by the Router/Global/Unrouted PUTs. */
export function buildOrchestrationPathBody(
  sets: OrchestrationSet[],
  catchAll: OrchestrationCatchAll,
): { orchestration_path: OrchestrationPathBody } {
  return { orchestration_path: { sets, catch_all: catchAll } }
}

/** Find a live orchestration by name (case-insensitive — the reconciliation identity). */
export function findOrchestration(orchestrations: LiveEventOrchestration[], name: string): LiveEventOrchestration | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return orchestrations.find((o) => String(o.name ?? '').trim().toLowerCase() === n) ?? null
}

/** Resolve a team NAME to its id (case-insensitive). */
export function findTeamId(teams: Array<{ id?: string; name?: string }>, name: string): string | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  const match = teams.find((t) => String(t.name ?? '').trim().toLowerCase() === n)
  return match?.id ?? null
}
