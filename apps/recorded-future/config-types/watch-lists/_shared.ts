// Shared helpers for the Recorded Future Watch Lists config type
// (deploy + rollback + drift). Pure + network-free so they can be unit-tested.
//
// Endpoint paths and list `type` values follow the Recorded Future List API:
//   https://docs.recordedfuture.com/reference/lists-create (+ siblings)
// Entity-resolution semantics (type/name auto-resolution vs. RF entity id) are
// FLAGGED — VERIFY against a live Recorded Future account before production use.

import { LIST_API_PREFIX } from '../../lib/recordedFutureApi'

/**
 * Valid Recorded Future list `type` values accepted by POST /list/create.
 * Confirmed: https://docs.recordedfuture.com/reference/lists-create
 */
export const LIST_TYPES = new Set([
  'entity',
  'ip',
  'domain',
  'vulnerability',
  'hash',
  'company',
  'attacker',
  'executive',
  'source',
  'text',
])

/**
 * List types whose members Recorded Future can auto-resolve from a plain
 * type + name pair (POST /list/{id}/entity/add { entity: { type, name } }).
 * For every OTHER list type the entity must be given as an RF entity id
 * (`{ entity: { id } }`). VERIFY the RF type strings against a live account.
 *   Doc note: "Auto-resolution by type/name works only for IpAddress,
 *   InternetDomainName, Hash, and CyberVulnerability."
 */
export const AUTO_RESOLVE_TYPES: Record<string, string> = {
  ip: 'IpAddress',
  domain: 'InternetDomainName',
  hash: 'Hash',
  vulnerability: 'CyberVulnerability',
}

/** List metadata as returned by /list/create, /list/search and /list/{id}/info. */
export interface ListInfo {
  id?: string
  name?: string
  type?: string
  created?: string
  updated?: string
  owner_id?: string
  owner_name?: string
  organisation_id?: string
  organisation_name?: string
  [key: string]: unknown
}

/** One entity as it may appear in a list (/list/{id}/entities). Shape is best-effort. */
export interface ListEntity {
  id?: string
  name?: string
  type?: string
  [key: string]: unknown
}

// --- List API paths -----------------------------------------------------------
export const listPaths = {
  create: `${LIST_API_PREFIX}/create`,
  search: `${LIST_API_PREFIX}/search`,
  info: (id: string) => `${LIST_API_PREFIX}/${encodeURIComponent(id)}/info`,
  status: (id: string) => `${LIST_API_PREFIX}/${encodeURIComponent(id)}/status`,
  entities: (id: string) => `${LIST_API_PREFIX}/${encodeURIComponent(id)}/entities`,
  entityAdd: (id: string) => `${LIST_API_PREFIX}/${encodeURIComponent(id)}/entity/add`,
  entityRemove: (id: string) => `${LIST_API_PREFIX}/${encodeURIComponent(id)}/entity/remove`,
} as const

/** Trim + lowercase a value so two that differ only in case still match. */
export function normalize(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

/**
 * Parse the free-text `entities` field into a de-duplicated, ordered list of
 * entity references. Accepts one entity per line and/or comma-separated values.
 */
export function parseEntities(raw: unknown): string[] {
  const text = String(raw ?? '')
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of text.split(/[\r\n,]+/)) {
    const value = part.trim()
    if (!value) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

/**
 * Build the `entity` object for POST /list/{id}/entity/add from a list type and a
 * single reference value. Auto-resolvable types send `{ type, name }`; every other
 * type sends `{ id }` (the value must be a Recorded Future entity id). VERIFY.
 */
export function buildEntityRef(listType: string, value: string): ListEntity {
  const rfType = AUTO_RESOLVE_TYPES[normalize(listType)]
  return rfType ? { type: rfType, name: value } : { id: value }
}

/** Unwrap a /list/search (or similar) response into a flat array of ListInfo. */
export function listsFromResponse(json: unknown): ListInfo[] {
  if (Array.isArray(json)) return json as ListInfo[]
  if (json && typeof json === 'object') {
    const data = (json as Record<string, unknown>).data
    if (Array.isArray(data)) return data as ListInfo[]
  }
  return []
}

/** Unwrap a /list/{id}/entities response into a flat array of entities. */
export function entitiesFromResponse(json: unknown): ListEntity[] {
  if (Array.isArray(json)) return json as ListEntity[]
  if (json && typeof json === 'object') {
    const data = (json as Record<string, unknown>).entities ?? (json as Record<string, unknown>).data
    if (Array.isArray(data)) return data as ListEntity[]
  }
  return []
}

/** Find an existing list by exact (case-insensitive) name, preferring a matching type. */
export function findList(lists: ListInfo[], name: string, type: string): ListInfo | null {
  const n = normalize(name)
  if (!n) return null
  const sameType = lists.find((l) => normalize(l.name) === n && normalize(l.type) === normalize(type))
  if (sameType) return sameType
  return lists.find((l) => normalize(l.name) === n) ?? null
}

/**
 * Build the set of signatures present in a list's live entities — every entity's
 * lowercased id AND name — so a declared reference can be matched best-effort.
 */
export function entitySignatures(entities: ListEntity[]): Set<string> {
  const set = new Set<string>()
  for (const e of entities) {
    const id = normalize(e.id)
    const name = normalize(e.name)
    if (id) set.add(id)
    if (name) set.add(name)
  }
  return set
}
