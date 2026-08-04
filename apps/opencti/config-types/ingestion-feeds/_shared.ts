// Shared helpers for the OpenCTI TAXII2 Ingestion Feeds config type
// (deploy + rollback + drift).
//
// Verified against the OpenCTI GraphQL backend schema (opencti-platform/opencti,
// src/modules/ingestion/ingestion-taxii.graphql). `ingestionTaxiiAdd` /
// `ingestionTaxiiFieldPatch` / `ingestionTaxiiDelete` are flat top-level
// mutations and were already correct. Two corrections from an earlier,
// unverified "follow OpenCTI conventions" guess:
//   1. `TaxiiVersion` is `v1 | v2 | v21` — `"v20"` DOES NOT EXIST. The valid
//      pre-2.1 value is `"v2"`.
//   2. `IngestionTaxiiAddInput` REQUIRES `user_id: String!` (the OpenCTI user
//      the ingested data is attributed to) — omitting it (as the earlier
//      version did) fails schema validation on every create.
// Not yet covered (a good future-release candidate, out of scope here):
// `scheduling_period`, `confidence_to_score`, `ssl_verify`, `automatic_user`
// and `confidence_level` are additional optional fields on this same input.

/** TAXII protocol versions OpenCTI ingests (`TaxiiVersion` enum). */
export const TAXII_VERSIONS = new Set(['v1', 'v2', 'v21'])

/** Authentication schemes an OpenCTI TAXII feed supports. */
export const TAXII_AUTH_TYPES = new Set(['none', 'basic', 'bearer', 'certificate'])

/** Auth types that require an authentication value. */
export const TAXII_AUTH_TYPES_WITH_VALUE = new Set(['basic', 'bearer', 'certificate'])

/**
 * The node fields we read back on every feed (list + drift). `authentication_value`
 * is a secret and is intentionally NOT selected — OpenCTI does not return it, and it
 * must not be compared for drift. `user_id` is read back so rollback can restore
 * the prior attribution.
 */
export const FEED_NODE_FIELDS = 'id name uri collection version authentication_type ingestion_running user_id'

// --- GraphQL documents (verified against the OpenCTI backend schema) --------

/**
 * List every TAXII2 feed (paginated `edges { node }` connection). VERIFY: the list
 * field may be `ingestionTaxiiConnections` rather than `ingestionTaxiis`.
 */
export const LIST_FEEDS_QUERY = `query IngestionTaxiis {
  ingestionTaxiis {
    edges { node { ${FEED_NODE_FIELDS} } }
  }
}`

/** Create one TAXII2 feed. input: IngestionTaxiiAddInput! */
export const ADD_FEED_MUTATION = `mutation IngestionTaxiiAdd($input: IngestionTaxiiAddInput!) {
  ingestionTaxiiAdd(input: $input) { ${FEED_NODE_FIELDS} }
}`

/** Patch fields on an existing TAXII2 feed. input: [EditInput!]! */
export const PATCH_FEED_MUTATION = `mutation IngestionTaxiiEdit($id: ID!, $input: [EditInput!]!) {
  ingestionTaxiiEdit(id: $id, input: $input) { ${FEED_NODE_FIELDS} }
}`

/** Delete one TAXII2 feed by id — returns the deleted id. */
export const DELETE_FEED_MUTATION = `mutation IngestionTaxiiDelete($id: ID!) {
  ingestionTaxiiDelete(id: $id)
}`

/** One OpenCTI TAXII2 ingestion feed node (secret auth value never read back). */
export interface OpenctiFeed {
  id?: string
  name?: string
  uri?: string
  collection?: string
  version?: string | null
  authentication_type?: string | null
  ingestion_running?: boolean | null
  user_id?: string | null
  [key: string]: unknown
}

/** The `input` for ingestionTaxiiAdd. `user_id` is REQUIRED by the schema. */
export interface FeedAddInput {
  name: string
  uri: string
  collection: string
  version: string
  authentication_type: string
  authentication_value?: string
  added_after_start?: string
  user_id: string
}

/**
 * One EditInput entry for ingestionTaxiiFieldPatch. `value` is `[Any]` in the
 * OpenCTI schema (an unconstrained passthrough scalar) — send native JSON
 * types, never stringify booleans/numbers.
 */
export interface EditInput {
  key: string
  value: unknown[]
}

/** Unwrap an OpenCTI `{ ingestionTaxiis: { edges: [{ node }] } }` connection into a flat array. */
export function feedsFromList(data: unknown): OpenctiFeed[] {
  const edges = (data as { ingestionTaxiis?: { edges?: Array<{ node?: OpenctiFeed }> } } | null | undefined)
    ?.ingestionTaxiis?.edges
  if (!Array.isArray(edges)) return []
  return edges.map((e) => e?.node).filter((n): n is OpenctiFeed => !!n)
}

/** Find a live feed by its `name` (case-insensitive — the stable identity). */
export function findFeed(feeds: OpenctiFeed[], name: string): OpenctiFeed | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return feeds.find((f) => String(f.name ?? '').trim().toLowerCase() === n) ?? null
}

/** Trim a string field (undefined when blank). */
export function normalizeText(value: unknown): string | undefined {
  const s = String(value ?? '').trim()
  return s === '' ? undefined : s
}

/**
 * Build the ingestionTaxiiAdd input from canvas fields. `user_id` is REQUIRED
 * by the schema — the OpenCTI user the ingested data is attributed to.
 */
export function buildFeedInput(fields: Record<string, unknown>): FeedAddInput {
  const input: FeedAddInput = {
    name: String(fields.name ?? '').trim(),
    uri: String(fields.uri ?? '').trim(),
    collection: String(fields.collection ?? '').trim(),
    version: String(fields.version ?? '').trim(),
    authentication_type: String(fields.authentication_type ?? '').trim(),
    user_id: String(fields.user_id ?? '').trim(),
  }
  const authValue = normalizeText(fields.authentication_value)
  if (authValue !== undefined) input.authentication_value = authValue
  const addedAfter = normalizeText(fields.added_after_start)
  if (addedAfter !== undefined) input.added_after_start = addedAfter
  return input
}

/**
 * Build the ingestionTaxiiFieldPatch `input` (an array of EditInput) from canvas
 * fields. `value` is `[Any]` — sent as-is (all of this type's patched fields are
 * already strings). Only mutable fields are patched — `name` is the identity and
 * is not rewritten. The secret `authentication_value` is only patched when the
 * operator supplied a new one.
 */
export function buildFeedPatch(fields: Record<string, unknown>): EditInput[] {
  const patch: EditInput[] = [
    { key: 'uri', value: [String(fields.uri ?? '').trim()] },
    { key: 'collection', value: [String(fields.collection ?? '').trim()] },
    { key: 'version', value: [String(fields.version ?? '').trim()] },
    { key: 'authentication_type', value: [String(fields.authentication_type ?? '').trim()] },
    { key: 'user_id', value: [String(fields.user_id ?? '').trim()] },
  ]
  const authValue = normalizeText(fields.authentication_value)
  if (authValue !== undefined) patch.push({ key: 'authentication_value', value: [authValue] })
  const addedAfter = normalizeText(fields.added_after_start)
  if (addedAfter !== undefined) patch.push({ key: 'added_after_start', value: [addedAfter] })
  return patch
}

/**
 * Build an EditInput[] that restores a prior feed body (for rollback). The secret
 * `authentication_value` is never read back, so it cannot be restored here.
 */
export function buildRestorePatch(prior: OpenctiFeed): EditInput[] {
  const patch: EditInput[] = []
  if (prior.uri != null) patch.push({ key: 'uri', value: [String(prior.uri)] })
  if (prior.collection != null) patch.push({ key: 'collection', value: [String(prior.collection)] })
  if (prior.version != null) patch.push({ key: 'version', value: [String(prior.version)] })
  if (prior.user_id != null) patch.push({ key: 'user_id', value: [String(prior.user_id)] })
  if (prior.authentication_type != null) patch.push({ key: 'authentication_type', value: [String(prior.authentication_type)] })
  return patch
}
