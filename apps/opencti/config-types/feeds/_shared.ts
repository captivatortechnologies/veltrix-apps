// Shared helpers for the OpenCTI Feeds (CSV/rolling export) config type
// (deploy + rollback + drift).
//
// Verified against the OpenCTI GraphQL backend schema (opencti-platform/opencti,
// src/modules/dataSharing/feed.graphql). This type's mutation shape is
// DIFFERENT from every other type in this app: `feedEdit(id, input:
// FeedAddInput!)` replaces the WHOLE input — there is no `[EditInput]` patch
// list. `buildFeedInput` below is used for BOTH create and update; there is no
// separate patch builder.
//
// IMPORTANT — because `feedEdit` is a whole-object replace, any field this
// canvas does not model (`feed_public_user_id`, `authorized_members`) would be
// silently CLEARED on every deploy of an existing feed if we naively rebuilt
// the input from canvas fields alone. To avoid that destructive side effect,
// `buildFeedInput` accepts the PRIOR live feed (when one exists) and carries
// `feed_public_user_id`/`authorized_members` through unchanged — this type
// never sets or clears them itself, it only preserves whatever was already
// there. `authorized_members.groups_restriction` (a nested per-group
// restriction) is NOT round-tripped — only `id`/`access_right` — a narrow,
// documented gap rather than a silent one.

/**
 * The node fields we read back on every feed (list + rollback capture).
 * Read in full (including `feed_attributes` and `filters`) because rollback
 * must be able to reconstruct a COMPLETE prior `FeedAddInput` for the
 * whole-object `feedEdit` replace.
 */
export const FEED_NODE_FIELDS = `id name description filters separator feed_date_attribute rolling_time include_header
  feed_types feed_public feed_public_user_id
  feed_attributes { attribute multi_match_strategy multi_match_separator mappings { type attribute relationship_type target_entity_type } }
  authorized_members { id access_right }`

// --- GraphQL documents --------------------------------------------------------

/** List every feed (paginated `edges { node }` connection). */
export const LIST_FEEDS_QUERY = `query Feeds {
  feeds {
    edges { node { ${FEED_NODE_FIELDS} } }
  }
}`

/** Create one feed. input: FeedAddInput! */
export const ADD_FEED_MUTATION = `mutation FeedAdd($input: FeedAddInput!) {
  feedAdd(input: $input) { ${FEED_NODE_FIELDS} }
}`

/**
 * Replace the WHOLE feed. input: FeedAddInput! — NOT an `[EditInput]` patch
 * list, unlike every other type in this app. The caller must send the full
 * desired state every time.
 */
export const EDIT_FEED_MUTATION = `mutation FeedEdit($id: ID!, $input: FeedAddInput!) {
  feedEdit(id: $id, input: $input) { ${FEED_NODE_FIELDS} }
}`

/** Delete one feed by id — returns the deleted id. */
export const DELETE_FEED_MUTATION = `mutation FeedDelete($id: ID!) {
  feedDelete(id: $id)
}`

/** One `FeedMapping` — one field a feed's row is built from. */
export interface FeedMapping {
  type: string
  attribute: string
  relationship_type?: string
  target_entity_type?: string
}

/** One `FeedAttribute` (read) / `FeedAttributeMappingInput` (write) — mirrored shapes. */
export interface FeedAttributeMapping {
  attribute: string
  mappings: FeedMapping[]
  multi_match_strategy?: string
  multi_match_separator?: string
}

/** One preserved member-access grant, round-tripped verbatim (never authored here). */
export interface OpenctiMemberAccess {
  id: string
  access_right: string
}

/** One OpenCTI feed node. */
export interface OpenctiFeed {
  id?: string
  name?: string
  description?: string | null
  filters?: string | null
  separator?: string
  feed_date_attribute?: string | null
  rolling_time?: number
  include_header?: boolean
  feed_types?: string[]
  feed_public?: boolean | null
  feed_public_user_id?: string | null
  feed_attributes?: FeedAttributeMapping[]
  authorized_members?: OpenctiMemberAccess[] | null
  [key: string]: unknown
}

/** The `input` for feedAdd/feedEdit — identical shape for create and update. */
export interface FeedAddInput {
  name: string
  description?: string
  filters?: string
  separator: string
  feed_date_attribute: string
  rolling_time: number
  include_header: boolean
  feed_types: string[]
  feed_public?: boolean
  feed_public_user_id?: string
  feed_attributes: FeedAttributeMapping[]
  authorized_members?: Array<{ id: string; access_right: string; groups_restriction_ids: string[] }>
}

/** Unwrap an OpenCTI `{ feeds: { edges: [{ node }] } }` connection into a flat array. */
export function feedsFromList(data: unknown): OpenctiFeed[] {
  const edges = (data as { feeds?: { edges?: Array<{ node?: OpenctiFeed }> } } | null | undefined)?.feeds?.edges
  if (!Array.isArray(edges)) return []
  return edges.map((e) => e?.node).filter((n): n is OpenctiFeed => !!n)
}

/** Find a live feed by its `name` (case-insensitive — the stable identity). */
export function findFeed(feeds: OpenctiFeed[], name: string): OpenctiFeed | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return feeds.find((f) => String(f.name ?? '').trim().toLowerCase() === n) ?? null
}

/** Normalize a "tags" canvas field into a de-duplicated string list. */
export function toStringList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.map((v) => String(v ?? '').trim())
    : String(value ?? '').split(',').map((v) => v.trim())
  const out: string[] = []
  for (const v of raw) if (v && !out.includes(v)) out.push(v)
  return out
}

/** Trim a string field (undefined when blank). */
export function normalizeText(value: unknown): string | undefined {
  const s = String(value ?? '').trim()
  return s === '' ? undefined : s
}

/** Coerce a canvas checkbox field to a boolean (defaulting to false when blank). */
export function normalizeBool(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  const s = String(value).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes') return true
  if (s === 'false' || s === '0' || s === 'no') return false
  return fallback
}

/**
 * Parse the canvas's `feed_attributes` JSON textarea into `FeedAttributeMapping[]`.
 * Throws on malformed JSON or a shape that isn't an array — callers (deploy) run
 * this after validate.ts has already confirmed it parses, so this should not
 * throw in practice; the shape check is shallow (an array of objects with a
 * string `attribute` and an array `mappings`), matching this app's
 * "JSON blob, shallow-validated" precedent for deeply-nested schemas.
 */
export function parseFeedAttributes(raw: unknown): FeedAttributeMapping[] {
  const text = String(raw ?? '').trim()
  if (!text) return []
  const parsed = JSON.parse(text)
  if (!Array.isArray(parsed)) throw new Error('feed_attributes must be a JSON array')
  return parsed as FeedAttributeMapping[]
}

/**
 * Build the feedAdd/feedEdit input from canvas fields. `prior` is the live
 * feed being updated (or null when creating) — `feed_public_user_id` and
 * `authorized_members` are carried through UNCHANGED from it, since this type
 * never authors those fields and `feedEdit` replaces the whole object.
 */
export function buildFeedInput(fields: Record<string, unknown>, prior: OpenctiFeed | null): FeedAddInput {
  const input: FeedAddInput = {
    name: String(fields.name ?? '').trim(),
    separator: String(fields.separator ?? '').trim(),
    feed_date_attribute: String(fields.feed_date_attribute ?? '').trim(),
    rolling_time: Number(fields.rolling_time ?? 0),
    include_header: normalizeBool(fields.include_header, true),
    feed_types: toStringList(fields.feed_types),
    feed_attributes: parseFeedAttributes(fields.feed_attributes),
  }
  const description = normalizeText(fields.description)
  if (description !== undefined) input.description = description
  const filters = normalizeText(fields.filters)
  if (filters !== undefined) input.filters = filters
  input.feed_public = normalizeBool(fields.feed_public, false)

  if (prior?.feed_public_user_id) input.feed_public_user_id = prior.feed_public_user_id
  if (Array.isArray(prior?.authorized_members) && prior.authorized_members.length > 0) {
    input.authorized_members = prior.authorized_members.map((m) => ({ id: m.id, access_right: m.access_right, groups_restriction_ids: [] }))
  }
  return input
}

/**
 * Build a full `FeedAddInput` directly from a PRIOR live feed node (for
 * rollback) — `feedEdit` needs the complete desired state, not a diff, so
 * restoring means re-sending the entire prior object exactly as it was read.
 */
export function buildRestoreInput(prior: OpenctiFeed): FeedAddInput {
  const input: FeedAddInput = {
    name: String(prior.name ?? '').trim(),
    separator: String(prior.separator ?? ''),
    feed_date_attribute: String(prior.feed_date_attribute ?? ''),
    rolling_time: Number(prior.rolling_time ?? 0),
    include_header: prior.include_header ?? true,
    feed_types: Array.isArray(prior.feed_types) ? prior.feed_types : [],
    feed_attributes: Array.isArray(prior.feed_attributes) ? prior.feed_attributes : [],
  }
  if (prior.description != null) input.description = String(prior.description)
  if (prior.filters != null) input.filters = String(prior.filters)
  if (prior.feed_public != null) input.feed_public = prior.feed_public
  if (prior.feed_public_user_id) input.feed_public_user_id = prior.feed_public_user_id
  if (Array.isArray(prior.authorized_members) && prior.authorized_members.length > 0) {
    input.authorized_members = prior.authorized_members.map((m) => ({ id: m.id, access_right: m.access_right, groups_restriction_ids: [] }))
  }
  return input
}
