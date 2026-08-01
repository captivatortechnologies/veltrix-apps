// Shared helpers for the Akamai Client Lists config type. Client Lists are the
// newer, richer replacement for Network Lists (IP/GEO plus ASN, TLS fingerprints,
// file hashes, user IDs, domains, and header name/value pairs).
//
// Endpoints (Client Lists API v1, EdgeGrid-signed) — VERIFIED against Akamai's
// official open-source Go SDK (github.com/akamai/AkamaiOPEN-edgegrid-golang,
// pkg/clientlists/client_list.go), which is the client the Akamai Terraform
// provider is built on. The interactive API reference at techdocs.akamai.com
// (/client-lists/reference) is login-gated, so paths + body shapes are sourced
// from the Go SDK, not the HTML reference:
//   list:   GET    /client-list/v1/lists?includeItems=true
//   get:    GET    /client-list/v1/lists/{listId}?includeItems=true
//   create: POST   /client-list/v1/lists            { contractId, groupId, name, type, notes, tags, items }
//   update: PUT    /client-list/v1/lists/{listId}   { name, notes, tags }          (details only; type is immutable)
//   items:  POST   /client-list/v1/lists/{listId}/items { append, update, delete } (batch element sync)
//   delete: DELETE /client-list/v1/lists/{listId}
// The `content` envelope key and the field names below are the Go SDK's json tags.

/** Valid Client List types (Go SDK ClientListType enum). */
export const CLIENT_LIST_TYPES = new Set([
  'IP',
  'GEO',
  'ASN',
  'TLS_FINGERPRINT',
  'FILE_HASH',
  'USER_ID',
  'DOMAIN',
  'REQUEST_HEADER_NAME_VALUE',
])

/** Akamai caps a client list at five tags, each up to 256 characters. */
export const MAX_TAGS = 5
export const MAX_TAG_LENGTH = 256

/** One Client List as returned by the API (fields we rely on). */
export interface ClientList {
  listId?: string
  name?: string
  type?: string
  notes?: string
  tags?: string[]
  version?: number
  itemsCount?: number
  items?: ClientListItem[]
  stagingActivationStatus?: string
  productionActivationStatus?: string
  readOnly?: boolean
  deprecated?: boolean
  [key: string]: unknown
}

/** One entry within a Client List (create/update payload uses value/description/tags/expirationDate). */
export interface ClientListItem {
  value?: string
  description?: string
  tags?: string[]
  expirationDate?: string
  [key: string]: unknown
}

/**
 * Unwrap the collection envelope. The Go SDK models the response as
 * `{ content: [...] }`; older/alternate shapes use `{ lists: [...] }` or a bare
 * array, all handled here defensively.
 */
export function clientListsFromResponse(payload: unknown): ClientList[] {
  if (payload && typeof payload === 'object') {
    const obj = payload as { content?: unknown; lists?: unknown }
    if (Array.isArray(obj.content)) return obj.content as ClientList[]
    if (Array.isArray(obj.lists)) return obj.lists as ClientList[]
  }
  return Array.isArray(payload) ? (payload as ClientList[]) : []
}

/** Normalize a type value from the canvas to a known Client List type (defaults to IP). */
export function normalizeClientListType(value: unknown): string {
  const t = String(value ?? '').trim().toUpperCase()
  return CLIENT_LIST_TYPES.has(t) ? t : 'IP'
}

/**
 * Parse a textarea of item values (one per line, or comma-separated) into a
 * clean, de-duplicated, order-preserving list. GEO country codes are upper-cased
 * so `us` and `US` collapse to one entry (other types keep their exact casing —
 * hashes and fingerprints are case-sensitive).
 */
export function parseItemValues(value: unknown, type: string): string[] {
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

/** Parse a tags field (array, or comma/newline list) into trimmed, de-duplicated tags. */
export function parseTags(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.map((v) => String(v)) : String(value ?? '').split(/[\r\n,]+/)
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of raw) {
    const e = entry.trim()
    if (!e) continue
    if (!seen.has(e)) {
      seen.add(e)
      out.push(e)
    }
  }
  return out
}

/** Coerce the groupId field (a canvas number) to a positive integer, or null. */
export function parseGroupId(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Find a live client list by (case-insensitive) name — the stable identity for upsert. */
export function findClientList(lists: ClientList[], name: string): ClientList | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return lists.find((l) => String(l.name ?? '').trim().toLowerCase() === n) ?? null
}

/** Extract the plain value strings held by a live client list. */
export function valuesFromList(list: ClientList): string[] {
  if (!Array.isArray(list.items)) return []
  return list.items.map((it) => String(it.value ?? '').trim()).filter(Boolean)
}

/** Order-insensitive equality of two string lists. */
export function sameStrings(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const bSet = new Set(b)
  return a.every((item) => bSet.has(item))
}

/** Compute the append/remove sets to turn `current` into `desired` (full replace). */
export function diffValues(desired: string[], current: string[]): { append: string[]; remove: string[] } {
  const desiredSet = new Set(desired)
  const currentSet = new Set(current)
  return {
    append: desired.filter((v) => !currentSet.has(v)),
    remove: current.filter((v) => !desiredSet.has(v)),
  }
}

/** Wrap plain values as ListItemPayload objects for create/append/delete. */
export function toItemPayload(values: string[]): ClientListItem[] {
  return values.map((value) => ({ value }))
}

export interface ClientListFields {
  name: string
  type: string
  notes: string
  tags: string[]
  contractId: string
  groupId: number | null
  values: string[]
}

/** Read + normalize the canvas fields for one Client List item. */
export function readClientListFields(fields: Record<string, unknown>): ClientListFields {
  const type = normalizeClientListType(fields.type)
  return {
    name: String(fields.name ?? '').trim(),
    type,
    notes: String(fields.notes ?? '').trim(),
    tags: parseTags(fields.tags),
    contractId: String(fields.contractId ?? '').trim(),
    groupId: parseGroupId(fields.groupId),
    values: parseItemValues(fields.items, type),
  }
}
