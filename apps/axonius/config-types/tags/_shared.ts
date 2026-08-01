// Shared helpers for the Axonius Tags config type (deploy + rollback + drift +
// validate). A tag is an asset label applied to every device/user matching an AQL
// filter. Shapes follow the axonius-api-client JSON:API surface; verify against a
// live Axonius tenant.
//
// Endpoints (verified against axonius_api_client master — api_endpoints.py):
//   GET    api/{devices|users}/labels   list existing label names (StrValue { value })
//   PUT    api/{devices|users}/labels   add   (request type_ add_tags_schema)
//   DELETE api/{devices|users}/labels   remove (same request body)
//
// Request body (verified ModifyTagsRequestSchema):
//   { entities: { ids: [...], include: bool }, labels: [...], filter, expirable_tags: [...] }
// include semantics (verified labels.py): include=true → assets IN ids;
// include=false → assets NOT in ids. To tag every asset matching an AQL filter in
// a single call we send an inverted empty selection (ids:[], include:false) plus
// the `filter` — i.e. "all assets not in the empty set, narrowed by the filter".
//
// FLAG: the single-call filter-based selection is inferred from the schema's
// `filter` field + the entities inversion convention; the api_client itself
// resolves ids client-side, so verify this form against a live Axonius tenant.

/** Axonius asset modules a tag can target. */
export const TAG_ENTITIES = ['devices', 'users'] as const
export type TagEntity = (typeof TAG_ENTITIES)[number]

/** JSON:API resource type for the add/remove tag request body. */
const ADD_TAGS_TYPE = 'add_tags_schema'

// --- Endpoint resource paths (relative to the API root, e.g. `api/`) ----------

/** PUT (add) / DELETE (remove) / GET (list) — labels for an asset module. */
export function labelsResource(entity: TagEntity): string {
  return `${entity}/labels`
}
/** GET — system metadata (about), used as the connectivity / health probe. */
export const META_ABOUT_RESOURCE = 'settings/meta/about'

// --- Field parsing ------------------------------------------------------------

/** Normalize an entity value to a known module, defaulting to devices. */
export function normalizeEntity(value: unknown): TagEntity {
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'users' ? 'users' : 'devices'
}

/** Trim a string canvas value. */
export function parseText(value: unknown): string {
  return String(value ?? '').trim()
}

/** ISO date (YYYY-MM-DD) shape for an optional tag expiration. */
export const EXPIRATION_RE = /^\d{4}-\d{2}-\d{2}$/

// --- Body building ------------------------------------------------------------

/** The entities selector that means "every asset matching the filter" (inverted empty set). */
export function selectAllEntities(): { ids: string[]; include: boolean } {
  return { ids: [], include: false }
}

/**
 * JSON:API body for the add/remove tag endpoints. `filter` narrows the inverted
 * empty selection to the assets that should carry the tag. `expiration`, when a
 * valid YYYY-MM-DD date, also records an expirable tag (verified: list of dicts
 * with `name` + `expiration_date`).
 */
export function buildTagBody(fields: {
  label: string
  filter: string
  expiration?: string
}): { data: { type: string; attributes: Record<string, unknown> } } {
  const expirable =
    fields.expiration && EXPIRATION_RE.test(fields.expiration)
      ? [{ name: fields.label, expiration_date: fields.expiration }]
      : []
  return {
    data: {
      type: ADD_TAGS_TYPE,
      attributes: {
        entities: selectAllEntities(),
        labels: [fields.label],
        filter: fields.filter,
        expirable_tags: expirable,
      },
    },
  }
}

// --- Response parsing ---------------------------------------------------------

/**
 * Flatten a labels list response into plain tag names. Handles the JSON:API
 * StrValue shape ({ data: [ { attributes: { value } } ] }), a bare string list,
 * and a { data: ["a","b"] } convenience shape.
 */
export function tagNamesFromResponse(json: unknown): string[] {
  const data = (json as { data?: unknown })?.data
  const rows = Array.isArray(data) ? data : Array.isArray(json) ? (json as unknown[]) : []
  const out: string[] = []
  for (const row of rows) {
    if (typeof row === 'string') {
      if (row.trim()) out.push(row.trim())
    } else if (row && typeof row === 'object') {
      const attrs = (row as { attributes?: Record<string, unknown> }).attributes ?? (row as Record<string, unknown>)
      const value = attrs.value ?? attrs.name
      if (typeof value === 'string' && value.trim()) out.push(value.trim())
    }
  }
  return out
}

/** Whether a tag name is present in a module's live label list. */
export function tagExists(names: string[], label: string): boolean {
  const l = label.trim()
  return !!l && names.some((n) => n === l)
}
