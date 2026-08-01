// Shared helpers for the Axonius Enforcement Sets config type (deploy + rollback +
// drift + validate). An enforcement set is a named policy: a "main" action drawn
// from the Axonius action library (an action_name + a per-action config) plus
// optional success/failure/post actions and triggers. Shapes follow the
// axonius-api-client JSON:API surface (api/enforcements); verify against a live
// Axonius tenant.
//
// Endpoints (verified against axonius_api_client master — api_endpoints.py):
//   GET    api/enforcements          list sets (EnforcementBasicModel)
//   GET    api/enforcements/{uuid}   full set (EnforcementFullModel) — rollback snapshot
//   POST   api/enforcements          create (type_ enforcements_schema)
//   PUT    api/enforcements/{uuid}   update (type_ enforcements_schema)
//   DELETE api/enforcements          delete (type_ enforcements_delete_schema)

/** JSON:API resource type for a create/update body (enforcements_schema). */
const ENFORCEMENT_SCHEMA_TYPE = 'enforcements_schema'
/** JSON:API resource type for the delete body (enforcements_delete_schema). */
const ENFORCEMENT_DELETE_TYPE = 'enforcements_delete_schema'

/** Max page size Axonius accepts on a resources GET (constants/api.py MAX_PAGE_SIZE). */
export const MAX_PAGE_SIZE = 2000

// --- Endpoint resource paths (relative to the API root, e.g. `api/`) ----------

/** GET — list every enforcement set (one generous page for identity + drift). */
export const ENFORCEMENTS_LIST_RESOURCE = `enforcements?page[limit]=${MAX_PAGE_SIZE}&page[offset]=0`
/** GET — one enforcement set's full definition by uuid (for a rollback snapshot). */
export function getEnforcementResource(uuid: string): string {
  return `enforcements/${encodeURIComponent(uuid)}`
}
/** POST — create an enforcement set. */
export const CREATE_ENFORCEMENT_RESOURCE = 'enforcements'
/** PUT — update an enforcement set by uuid. */
export function updateEnforcementResource(uuid: string): string {
  return `enforcements/${encodeURIComponent(uuid)}`
}
/** DELETE — remove an enforcement set (uuid carried in the body's value). */
export const DELETE_ENFORCEMENT_RESOURCE = 'enforcements'
/** GET — system metadata (about), used as the connectivity / health probe. */
export const META_ABOUT_RESOURCE = 'settings/meta/about'

// --- Types --------------------------------------------------------------------

/** The `action` object inside a set action ({ action_name, config }). */
export interface EnforcementAction {
  action_name?: string
  config?: Record<string, unknown>
}

/** One set action ({ name, action: { action_name, config } }). */
export interface EnforcementSetAction {
  name?: string
  action?: EnforcementAction
}

/** The `actions` dict of an enforcement set (main + optional chains). */
export interface EnforcementActions {
  main?: EnforcementSetAction
  success?: EnforcementSetAction[]
  failure?: EnforcementSetAction[]
  post?: EnforcementSetAction[]
  [key: string]: unknown
}

/**
 * One enforcement set, flattened from a JSON:API `{ id, attributes }` row. The
 * list endpoint returns the summary fields (`actions_main_*`); the by-uuid GET
 * returns the full `actions` / `triggers` used for a rollback snapshot.
 */
export interface AxoniusEnforcement {
  id?: string
  uuid?: string
  name?: string
  description?: string
  // Summary fields from the list endpoint (EnforcementBasicModel):
  actions_main?: string
  actions_main_name?: string
  actions_main_type?: string
  triggers_view_name?: string | null
  // Full fields from the by-uuid endpoint (EnforcementFullModel):
  actions?: EnforcementActions
  triggers?: Record<string, unknown>[]
  [key: string]: unknown
}

// --- Field parsing ------------------------------------------------------------

/** Trim a string canvas value to a clean string. */
export function parseText(value: unknown): string {
  return String(value ?? '').trim()
}

/**
 * Parse a JSON object from a canvas value. An empty value yields an empty object.
 * Returns a discriminated result so validate can surface a precise message and
 * deploy can refuse a malformed config rather than sending garbage.
 */
export function parseJsonObject(value: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const raw = String(value ?? '').trim()
  if (!raw) return { ok: true, value: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'must be a JSON object' }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

/**
 * Parse a JSON array of trigger objects from a canvas value. An empty value
 * yields an empty array (a set with no trigger runs only on demand).
 */
export function parseJsonArray(value: unknown): { ok: true; value: Record<string, unknown>[] } | { ok: false; error: string } {
  const raw = String(value ?? '').trim()
  if (!raw) return { ok: true, value: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid JSON' }
  }
  if (!Array.isArray(parsed)) return { ok: false, error: 'must be a JSON array' }
  return { ok: true, value: parsed as Record<string, unknown>[] }
}

// --- Body building ------------------------------------------------------------

/**
 * Build a `main` set action from the canvas fields (verified get_action_obj shape):
 *   { name, action: { action_name, config } }
 */
export function buildMainAction(name: string, actionName: string, config: Record<string, unknown>): EnforcementSetAction {
  return { name, action: { action_name: actionName, config } }
}

/** Wrap a main action into the full `actions` dict (verified _create shape). */
export function buildActions(main: EnforcementSetAction): EnforcementActions {
  return { main, success: [], failure: [], post: [] }
}

/** JSON:API create body for an enforcement set (enforcements_schema). */
export function buildCreateBody(fields: {
  name: string
  actions: EnforcementActions
  triggers: Record<string, unknown>[]
  description?: string
}): { data: { type: string; attributes: Record<string, unknown> } } {
  return {
    data: {
      type: ENFORCEMENT_SCHEMA_TYPE,
      attributes: {
        name: fields.name,
        actions: fields.actions,
        triggers: fields.triggers,
        description: fields.description ?? '',
      },
    },
  }
}

/**
 * JSON:API update body for an enforcement set (enforcements_schema). The update
 * schema also carries the uuid in the body (verified UpdateEnforcementRequestSchema).
 */
export function buildUpdateBody(fields: {
  uuid: string
  name: string
  actions: EnforcementActions
  triggers: Record<string, unknown>[]
}): { data: { type: string; attributes: Record<string, unknown> } } {
  return {
    data: {
      type: ENFORCEMENT_SCHEMA_TYPE,
      attributes: {
        name: fields.name,
        uuid: fields.uuid,
        actions: fields.actions,
        triggers: fields.triggers,
      },
    },
  }
}

/**
 * JSON:API update body that restores a prior full snapshot verbatim (rollback of
 * an updated set) — the exact prior name/actions/triggers keyed by uuid.
 */
export function buildRestoreBody(uuid: string, attributes: Record<string, unknown>): {
  data: { type: string; attributes: Record<string, unknown> }
} {
  return buildUpdateBody({
    uuid,
    name: String(attributes.name ?? ''),
    actions: (attributes.actions as EnforcementActions) ?? buildActions({}),
    triggers: Array.isArray(attributes.triggers) ? (attributes.triggers as Record<string, unknown>[]) : [],
  })
}

/**
 * JSON:API delete body (enforcements_delete_schema). The uuid is carried inside
 * `value` as an entities selector (verified _delete: ids=[uuid], include=true).
 */
export function buildDeleteBody(uuid: string): { data: { type: string; attributes: Record<string, unknown> } } {
  return {
    data: {
      type: ENFORCEMENT_DELETE_TYPE,
      attributes: { value: { ids: [uuid], include: true } },
    },
  }
}

// --- Response parsing ---------------------------------------------------------

/** Flatten a JSON:API `{ data: [ { id, attributes } ] }` list into enforcement sets. */
export function enforcementsFromResponse(json: unknown): AxoniusEnforcement[] {
  const data = (json as { data?: unknown })?.data
  const rows = Array.isArray(data) ? data : Array.isArray(json) ? (json as unknown[]) : []
  return rows.map((row) => flattenEnforcement(row))
}

/** Flatten a single JSON:API `{ data: { id, attributes } }` document (by-uuid GET). */
export function enforcementFromResponse(json: unknown): AxoniusEnforcement | null {
  const data = (json as { data?: unknown })?.data
  if (!data) return null
  return flattenEnforcement(data)
}

function flattenEnforcement(row: unknown): AxoniusEnforcement {
  if (row && typeof row === 'object' && 'attributes' in (row as Record<string, unknown>)) {
    const r = row as { id?: string; attributes?: Record<string, unknown> }
    const attrs = r.attributes ?? {}
    return { id: r.id, uuid: (attrs.uuid as string) ?? r.id, ...attrs } as AxoniusEnforcement
  }
  return row as AxoniusEnforcement
}

/** The uuid of an enforcement set, from either its inline uuid or JSON:API id. */
export function enforcementId(e: AxoniusEnforcement | null | undefined): string | null {
  const id = e?.uuid ?? e?.id
  return typeof id === 'string' && id ? id : null
}

/**
 * Find a live enforcement set by name — the stable identity we upsert on. Names
 * are unique per tenant in Axonius, so this is an exact, case-sensitive match.
 */
export function findEnforcement(list: AxoniusEnforcement[], name: string): AxoniusEnforcement | null {
  const n = name.trim()
  if (!n) return null
  return list.find((e) => String(e.name ?? '').trim() === n) ?? null
}

/** The live main action_name (type), from the summary field or the full actions dict. */
export function liveActionName(e: AxoniusEnforcement | null | undefined): string {
  if (!e) return ''
  if (e.actions_main_type) return String(e.actions_main_type).trim()
  return String(e.actions?.main?.action?.action_name ?? '').trim()
}
