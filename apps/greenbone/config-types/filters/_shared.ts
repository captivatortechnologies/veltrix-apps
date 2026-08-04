// Shared helpers for the Greenbone Filters config type (deploy + rollback +
// drift). A filter is a named, reusable search-term scoped to a resource type.
// Applied over GMP (XML over TLS). The filter NAME is the stable identity used
// to upsert — gvmd does not enforce unique names, so this app treats the name
// as the key (last one wins).

import type { FilterInput, GmpFilter } from '../../lib/gmp/filters'

export function buildFilterInput(fields: Record<string, unknown>): FilterInput {
  return {
    name: String(fields.name ?? '').trim(),
    type: String(fields.type ?? '').trim(),
    term: String(fields.term ?? '').trim(),
    comment: String(fields.comment ?? '').trim(),
  }
}

/** Find a live filter by name (trimmed, case-sensitive). */
export function findFilterByName(filters: GmpFilter[], name: string): GmpFilter | null {
  const n = name.trim()
  if (!n) return null
  return filters.find((f) => f.name.trim() === n) ?? null
}
