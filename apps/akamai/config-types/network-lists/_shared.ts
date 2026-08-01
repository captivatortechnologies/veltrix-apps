// Shared helpers for the Akamai Network Lists config type (deploy + rollback +
// drift). Shapes follow the Network Lists API v2 (GET/POST/PUT/DELETE
// /network-list/v2/network-lists[/{id}]).

/** Valid Network List types: IP addresses/CIDR blocks, or two-letter country codes. */
export const NETWORK_LIST_TYPES = new Set(['IP', 'GEO'])

/** One Network List as returned by the API (fields we rely on). */
export interface NetworkList {
  uniqueId?: string
  name?: string
  type?: string
  description?: string
  /** Version counter — required (and must match) when updating via PUT. */
  syncPoint?: number
  elementCount?: number
  list?: string[]
  readOnly?: boolean
  [key: string]: unknown
}

/** Unwrap the `{ networkLists: [...] }` collection envelope into a flat array. */
export function listsFromResponse(payload: unknown): NetworkList[] {
  if (payload && typeof payload === 'object' && Array.isArray((payload as { networkLists?: unknown }).networkLists)) {
    return (payload as { networkLists: NetworkList[] }).networkLists
  }
  return Array.isArray(payload) ? (payload as NetworkList[]) : []
}

/**
 * Parse a textarea of elements (one per line, or comma-separated) into a clean,
 * de-duplicated, order-preserving list of trimmed entries. GEO country codes are
 * upper-cased so `us` and `US` collapse to one entry.
 */
export function parseElements(value: unknown, type: string): string[] {
  const raw = Array.isArray(value) ? value.map((v) => String(v)) : String(value ?? '').split(/[\r\n,]+/)
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of raw) {
    let e = entry.trim()
    if (!e) continue
    if (type === 'GEO') e = e.toUpperCase()
    if (!seen.has(e)) {
      seen.add(e)
      out.push(e)
    }
  }
  return out
}

/** Normalize a type value from the canvas to `IP` or `GEO` (defaults to IP). */
export function normalizeType(value: unknown): string {
  const t = String(value ?? '').trim().toUpperCase()
  return NETWORK_LIST_TYPES.has(t) ? t : 'IP'
}

/** Find a live list by (case-insensitive) name — the stable identity for upsert. */
export function findList(lists: NetworkList[], name: string): NetworkList | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return lists.find((l) => String(l.name ?? '').trim().toLowerCase() === n) ?? null
}

/** Order-insensitive equality of two element lists. */
export function sameElements(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const bSet = new Set(b)
  return a.every((item) => bSet.has(item))
}

export interface NetworkListFields {
  name: string
  type: string
  description: string
  elements: string[]
}

/** Read + normalize the canvas fields for one Network List item. */
export function readListFields(fields: Record<string, unknown>): NetworkListFields {
  const type = normalizeType(fields.type)
  return {
    name: String(fields.name ?? '').trim(),
    type,
    description: String(fields.description ?? '').trim(),
    elements: parseElements(fields.list, type),
  }
}
