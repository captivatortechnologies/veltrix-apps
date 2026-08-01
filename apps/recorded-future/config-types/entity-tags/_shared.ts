// Shared helpers for the Recorded Future Watch List Entity Tags config type
// (deploy + rollback + drift). Pure + network-free so they can be unit-tested.
//
// Surface: the Recorded Future List API "Replace Entity Tags" endpoint, which sets
// the COMPLETE tag set on one entity of a company-type list (a Third-Parties Watch
// List). Confirmed against docs.recordedfuture.com:
//   POST /list/{listId}/entity/tags      { entity, tags }   → replaces all tags
//   GET  /list/{listId}/entitiesWithTags                    → entities + their tags
//   Refs: lists-replace-entity-tags, lists-entities-with-tags, lists-available-tags
//
// Tag updates are supported ONLY on company-type lists; a max of 9 tags may be
// applied to a single entity. Tags are a fixed Recorded Future vocabulary
// (AVAILABLE_TAGS below) — the snapshot is best-effort; VERIFY against a live
// account. Entity resolution ({ id } vs { type: "Company", name }) mirrors the
// Watch Lists type and is likewise VERIFY-flagged.

import { LIST_API_PREFIX } from '../../lib/recordedFutureApi'

/** Recorded Future list `type` that supports entity tagging (Third-Parties Watch List). */
export const COMPANY_LIST_TYPE = 'company'

/** RF entity type used when resolving a company entity by name. */
export const COMPANY_ENTITY_TYPE = 'Company'

/** Documented hard limit: at most 9 tags on a single entity. */
export const MAX_TAGS_PER_ENTITY = 9

/**
 * Known Recorded Future entity-list tag vocabulary (API names). Best-effort
 * snapshot from docs.recordedfuture.com/reference/lists-available-tags — used for
 * an advisory validation WARNING only (the API is the final authority), so an
 * unrecognised-but-well-formed tag is not hard-rejected. VERIFY against a live account.
 */
export const AVAILABLE_TAGS = new Set<string>([
  'tier0', 'tier1', 'tier2', 'tier3',
  'critical', 'high', 'medium', 'low',
  '3rd_party', '4th_party',
  'availability', 'business_continuity', 'c_suite', 'ceo', 'cfo', 'coo', 'cloud',
  'confidentiality', 'confidential_data', 'confirmed', 'critical_infrastructure',
  'customer_data', 'cyber_vendor', 'development', 'dmz', 'dora', 'ecommerce',
  'eol', 'eos', 'false_negative', 'false_positive', 'financial', 'finished_goods',
  'gdpr', 'hipaa', 'information_and_communication_technology', 'integrity',
  'internal', 'internet_facing', 'iso_27001', 'm_and_a', 'monitoring',
  'most_critical_supplier', 'network_connectivity', 'no_patch_available',
  'pci_dss', 'pii', 'potential', 'production', 'protected_health_information',
  'raw_materials', 'sox', 'subsidiary', 'temp_incident', 'true_negative',
  'true_positive', 'unpatched',
])

/** How the operator's `entityRef` value should be interpreted. */
export type MatchBy = 'id' | 'name'

/** Valid `matchBy` values. */
export const MATCH_BY_VALUES = new Set<MatchBy>(['id', 'name'])

/** An entity reference sent to the List API (either an RF id or a Company type/name). */
export interface EntityRef {
  id?: string
  type?: string
  name?: string
}

/** List metadata as returned by /list/search. */
export interface ListInfo {
  id?: string
  name?: string
  type?: string
  [key: string]: unknown
}

/** One tag as returned by /list/{id}/entitiesWithTags (object) — may also arrive as a bare string. */
export interface EntityTag {
  id?: string
  name?: string
  [key: string]: unknown
}

/** One entity-with-tags row from GET /list/{id}/entitiesWithTags. */
export interface TaggedEntity {
  entity?: { id?: string; type?: string; name?: string }
  tags?: Array<EntityTag | string>
  status?: string
  added?: string
  [key: string]: unknown
}

// --- List API paths this type uses --------------------------------------------
export const entityTagPaths = {
  search: `${LIST_API_PREFIX}/search`,
  entitiesWithTags: (id: string) => `${LIST_API_PREFIX}/${encodeURIComponent(id)}/entitiesWithTags`,
  entityTags: (id: string) => `${LIST_API_PREFIX}/${encodeURIComponent(id)}/entity/tags`,
} as const

/** Trim + lowercase a value so two that differ only in case still match. */
export function normalize(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

/** RF tag pattern — lowercase letters, digits and underscores (matches every AVAILABLE_TAGS value). */
export const TAG_PATTERN = /^[a-z0-9_]+$/

/**
 * Parse a tags field (the canvas `tags` fieldType yields a string[]; a comma /
 * newline string is also accepted) into a normalised, de-duplicated, ordered list.
 */
export function parseTags(raw: unknown): string[] {
  const parts: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[\r\n,]+/)
      : []
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of parts) {
    const value = normalize(part)
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/**
 * Build the `entity` object for the tag endpoints from a `matchBy` choice and a
 * single reference value: an RF entity id (`{ id }`) or a company name resolved by
 * type (`{ type: "Company", name }`). VERIFY the resolution semantics live.
 */
export function buildEntityRef(matchBy: string, ref: string): EntityRef {
  return normalize(matchBy) === 'name' ? { type: COMPANY_ENTITY_TYPE, name: ref } : { id: ref }
}

/** Unwrap a /list/search response into a flat array of ListInfo. */
export function listsFromResponse(json: unknown): ListInfo[] {
  if (Array.isArray(json)) return json as ListInfo[]
  if (json && typeof json === 'object') {
    const data = (json as Record<string, unknown>).data
    if (Array.isArray(data)) return data as ListInfo[]
  }
  return []
}

/** Find a company-type list by exact (case-insensitive) name, preferring the company type. */
export function findCompanyList(lists: ListInfo[], name: string): ListInfo | null {
  const n = normalize(name)
  if (!n) return null
  const company = lists.find((l) => normalize(l.name) === n && normalize(l.type) === COMPANY_LIST_TYPE)
  if (company) return company
  return lists.find((l) => normalize(l.name) === n) ?? null
}

/** Unwrap a /list/{id}/entitiesWithTags response into a flat array of rows. */
export function taggedEntitiesFromResponse(json: unknown): TaggedEntity[] {
  if (Array.isArray(json)) return json as TaggedEntity[]
  if (json && typeof json === 'object') {
    const data = (json as Record<string, unknown>).data ?? (json as Record<string, unknown>).entities
    if (Array.isArray(data)) return data as TaggedEntity[]
  }
  return []
}

/** Extract a tag's API name from an object ({ name } or an `enum:EntityListTag:<name>` id) or a bare string. */
export function tagName(tag: EntityTag | string): string {
  if (typeof tag === 'string') return normalize(tag)
  if (tag && typeof tag === 'object') {
    if (tag.name) return normalize(tag.name)
    if (typeof tag.id === 'string' && tag.id) return normalize(tag.id.split(':').pop())
  }
  return ''
}

/** The de-duplicated set of tag names on one entity-with-tags row. */
export function tagsOf(row: TaggedEntity | null | undefined): Set<string> {
  const set = new Set<string>()
  for (const tag of row?.tags ?? []) {
    const name = tagName(tag)
    if (name) set.add(name)
  }
  return set
}

/** Find the entity-with-tags row that matches a reference by RF id or by name. */
export function findTaggedEntity(
  rows: TaggedEntity[],
  matchBy: string,
  ref: string,
): TaggedEntity | null {
  const wanted = normalize(ref)
  if (!wanted) return null
  if (normalize(matchBy) === 'name') {
    return rows.find((r) => normalize(r.entity?.name) === wanted) ?? null
  }
  return rows.find((r) => normalize(r.entity?.id) === wanted) ?? null
}

/** True when two tag collections hold exactly the same set of names. */
export function sameTagSet(a: Iterable<string>, b: Iterable<string>): boolean {
  const sa = new Set([...a].map(normalize).filter(Boolean))
  const sb = new Set([...b].map(normalize).filter(Boolean))
  if (sa.size !== sb.size) return false
  for (const v of sa) if (!sb.has(v)) return false
  return true
}
