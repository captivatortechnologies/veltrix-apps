// Shared helpers for the Axonius Saved Queries config type (deploy + rollback +
// drift + validate). Saved queries are the writable, reusable asset views in
// Axonius — a named AQL filter over the devices or users module plus the columns
// to show. Shapes follow the axonius-api-client JSON:API surface; verify against a
// live Axonius tenant.

/** Axonius asset modules a saved query can target. */
export const SAVED_QUERY_ENTITIES = ['devices', 'users'] as const
export type SavedQueryEntity = (typeof SAVED_QUERY_ENTITIES)[number]

/** JSON:API resource type for a saved-query create/update body (type_ "views_schema"). */
const VIEWS_SCHEMA_TYPE = 'views_schema'
/** JSON:API resource type for the delete body (PrivateRequest, type_ "private_schema"). */
const PRIVATE_SCHEMA_TYPE = 'private_schema'

/** Max page size Axonius accepts on a resources GET (constants/api.py MAX_PAGE_SIZE). */
export const MAX_PAGE_SIZE = 2000

// --- Endpoint resource paths (relative to the API root, e.g. `api/`) ----------

/** GET — list every saved query (one generous page for identity-matching + drift). */
export const SAVED_QUERIES_LIST_RESOURCE = `queries/saved?page[limit]=${MAX_PAGE_SIZE}&page[offset]=0`
/** POST — create a saved query for an asset module (devices|users). */
export function createSavedQueryResource(entity: SavedQueryEntity): string {
  return `queries/${entity}`
}
/** PUT — update a saved query by its uuid. */
export function updateSavedQueryResource(uuid: string): string {
  return `queries/${encodeURIComponent(uuid)}`
}
/** DELETE — remove a saved query by its uuid. */
export function deleteSavedQueryResource(uuid: string): string {
  return `queries/query/${encodeURIComponent(uuid)}`
}
/** GET — system metadata (about), used as the connectivity / health probe. */
export const META_ABOUT_RESOURCE = 'settings/meta/about'

// --- Types --------------------------------------------------------------------

/** The Axonius `view` object inside a saved query. */
export interface SavedQueryView {
  query?: { filter?: string; expressions?: unknown[] }
  fields?: string[]
  sort?: { field?: string; desc?: boolean }
  [key: string]: unknown
}

/** One saved query, flattened from a JSON:API `{ id, attributes }` row. */
export interface AxoniusSavedQuery {
  id?: string
  uuid?: string
  name?: string
  module?: string
  description?: string
  tags?: string[]
  view?: SavedQueryView
  predefined?: boolean
  [key: string]: unknown
}

// --- Field parsing ------------------------------------------------------------

/** Normalize an entity value to a known module, defaulting to devices. */
export function normalizeEntity(value: unknown): SavedQueryEntity {
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'users' ? 'users' : 'devices'
}

/** The AQL filter string from the canvas `query` field (empty = all assets). */
export function parseFilter(value: unknown): string {
  return String(value ?? '').trim()
}

/**
 * Parse the `fields` (columns) canvas value into a clean list of Axonius field
 * names. Accepts a `tags` array or a comma/newline separated string; blanks and
 * duplicates are dropped, order preserved.
 */
export function parseFields(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.map((v) => String(v ?? ''))
    : String(value ?? '').split(/[\n,]/)
  const out: string[] = []
  for (const entry of raw) {
    const f = entry.trim()
    if (f && !out.includes(f)) out.push(f)
  }
  return out
}

// --- Body building ------------------------------------------------------------

/** Build the Axonius `view` object from the canvas filter + columns. */
export function buildView(filter: string, fields: string[]): SavedQueryView {
  const view: SavedQueryView = { query: { filter } }
  if (fields.length > 0) view.fields = fields
  return view
}

/** JSON:API create/update body for a saved query. */
export function buildSavedQueryBody(fields: {
  name: string
  filter: string
  columns: string[]
  description?: string
  tags?: string[]
}): { data: { type: string; attributes: Record<string, unknown> } } {
  return {
    data: {
      type: VIEWS_SCHEMA_TYPE,
      attributes: {
        name: fields.name,
        view: buildView(fields.filter, fields.columns),
        description: fields.description ?? '',
        tags: fields.tags ?? [],
        private: false,
        always_cached: false,
        asset_scope: false,
      },
    },
  }
}

/**
 * JSON:API update body that restores a prior saved-query snapshot verbatim (used
 * by rollback) — the exact prior name/view/description/tags, wrapped with the
 * views_schema type and the standard safety flags.
 */
export function buildRestoreBody(attributes: Record<string, unknown>): {
  data: { type: string; attributes: Record<string, unknown> }
} {
  return {
    data: {
      type: VIEWS_SCHEMA_TYPE,
      attributes: {
        name: attributes.name ?? '',
        view: attributes.view ?? {},
        description: attributes.description ?? '',
        tags: attributes.tags ?? [],
        private: false,
        always_cached: false,
        asset_scope: false,
      },
    },
  }
}

/** JSON:API body for the delete endpoint (PrivateRequest). */
export function buildDeleteBody(): { data: { type: string; attributes: Record<string, unknown> } } {
  return { data: { type: PRIVATE_SCHEMA_TYPE, attributes: { private: false } } }
}

// --- Response parsing ---------------------------------------------------------

/** Flatten a JSON:API `{ data: [ { id, attributes } ] }` list into saved queries. */
export function savedQueriesFromResponse(json: unknown): AxoniusSavedQuery[] {
  const data = (json as { data?: unknown })?.data
  const rows = Array.isArray(data) ? data : Array.isArray(json) ? (json as unknown[]) : []
  return rows.map((row) => {
    if (row && typeof row === 'object' && 'attributes' in (row as Record<string, unknown>)) {
      const r = row as { id?: string; attributes?: Record<string, unknown> }
      return { id: r.id, uuid: r.id, ...(r.attributes ?? {}) } as AxoniusSavedQuery
    }
    return row as AxoniusSavedQuery
  })
}

/** The uuid of a saved query, from either its JSON:API id or an inline uuid. */
export function savedQueryId(sq: AxoniusSavedQuery | null | undefined): string | null {
  const id = sq?.id ?? sq?.uuid
  return typeof id === 'string' && id ? id : null
}

/** Whether a live saved query belongs to the given asset module. */
function moduleMatches(sq: AxoniusSavedQuery, entity: SavedQueryEntity): boolean {
  const mod = String(sq.module ?? '').trim().toLowerCase()
  return !mod || mod === entity || mod.startsWith(entity)
}

/**
 * Find a live saved query by name within an asset module — the stable identity we
 * upsert on. A predefined (system) query with the same name is ignored so we never
 * try to overwrite an Axonius built-in.
 */
export function findSavedQuery(
  list: AxoniusSavedQuery[],
  name: string,
  entity: SavedQueryEntity,
): AxoniusSavedQuery | null {
  const n = name.trim()
  if (!n) return null
  return (
    list.find(
      (sq) => String(sq.name ?? '').trim() === n && moduleMatches(sq, entity) && sq.predefined !== true,
    ) ?? null
  )
}
