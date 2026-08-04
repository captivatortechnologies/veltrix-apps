// Shared helpers for the Vectra Entity Tags config type (deploy + rollback + drift).
//
// Declares the desired tag set on ONE host or account, identified by its numeric
// Vectra entity id — the same kind of id the Groups config type's host-type
// membership already declares directly (config-types/groups). Full replace per
// entity. Shapes follow Vectra's official client (vectra_api_tools):
//   read:  GET   /tagging/{host|account}/{id}   → { tags: [...] }
//   write: PATCH /tagging/{host|account}/{id}   body { tags: [...] }  (full replace)
//
// One config type covers both host and account tags (a canvas `entity_type` field
// selects the API path) rather than duplicating near-identical host-tags/account-tags
// config types — the wire shape is identical for both.
//
// Detection tags exist on the same API family (/tagging/detection/{id}) but are NOT
// modeled here — a detection is a single, short-lived event instance, not a durable
// entity worth declaring desired state for (see README Coverage).

export const ENTITY_TYPES = new Set(['host', 'account'])

/** Split a comma/newline-separated field into a trimmed, de-duplicated list. */
export function parseTags(value: unknown): string[] {
  const seen = new Set<string>()
  return String(value ?? '')
    .split(/[,\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !seen.has(s) && (seen.add(s), true))
}

/** Read the live tags array from a GET response, tolerant of an absent/odd shape. */
export function tagsFromGet(body: unknown): string[] {
  const o = (body ?? {}) as { tags?: unknown }
  return Array.isArray(o.tags) ? o.tags.map((t) => String(t).trim()).filter(Boolean) : []
}

/** The tagging API path for an entity ('host' | 'account') by its numeric id. */
export function taggingPath(entityType: string, entityId: string): string {
  return `/tagging/${entityType}/${encodeURIComponent(entityId)}`
}

/** Order-insensitive comparison key for a tag list. */
export function sortedJoin(list: string[]): string {
  return [...list].sort().join(', ')
}
