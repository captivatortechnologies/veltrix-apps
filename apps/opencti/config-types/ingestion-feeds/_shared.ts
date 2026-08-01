// Shared helpers for the OpenCTI TAXII2 Ingestion Feeds config type
// (deploy + rollback + drift).
//
// The GraphQL operations below follow OpenCTI conventions (ingestionTaxiis,
// ingestionTaxiiAdd, ingestionTaxiiEdit, ingestionTaxiiDelete). The list field may
// instead be `ingestionTaxiiConnections`; VERIFY every operation + field name (and
// the IngestionTaxiiAddInput / EditInput shapes) against a live OpenCTI instance.

/** TAXII protocol versions OpenCTI ingests. */
export const TAXII_VERSIONS = new Set(['v21', 'v20'])

/** Authentication schemes an OpenCTI TAXII feed supports. */
export const TAXII_AUTH_TYPES = new Set(['none', 'basic', 'bearer', 'certificate'])

/** Auth types that require an authentication value. */
export const TAXII_AUTH_TYPES_WITH_VALUE = new Set(['basic', 'bearer', 'certificate'])

/**
 * The node fields we read back on every feed (list + drift). `authentication_value`
 * is a secret and is intentionally NOT selected — OpenCTI does not return it, and it
 * must not be compared for drift. `version`/`authentication_type` are added for
 * drift beyond the task's list shape; VERIFY they are selectable.
 */
export const FEED_NODE_FIELDS = 'id name uri collection version authentication_type ingestion_running'

// --- GraphQL documents (verify against a live OpenCTI instance) --------------

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
  [key: string]: unknown
}

/** The `input` for ingestionTaxiiAdd. */
export interface FeedAddInput {
  name: string
  uri: string
  collection: string
  version: string
  authentication_type: string
  authentication_value?: string
  added_after_start?: string
}

/** One EditInput entry for ingestionTaxiiEdit (`value` is a list of strings). */
export interface EditInput {
  key: string
  value: string[]
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

/** Build the ingestionTaxiiAdd input from canvas fields. */
export function buildFeedInput(fields: Record<string, unknown>): FeedAddInput {
  const input: FeedAddInput = {
    name: String(fields.name ?? '').trim(),
    uri: String(fields.uri ?? '').trim(),
    collection: String(fields.collection ?? '').trim(),
    version: String(fields.version ?? '').trim(),
    authentication_type: String(fields.authentication_type ?? '').trim(),
  }
  const authValue = normalizeText(fields.authentication_value)
  if (authValue !== undefined) input.authentication_value = authValue
  const addedAfter = normalizeText(fields.added_after_start)
  if (addedAfter !== undefined) input.added_after_start = addedAfter
  return input
}

/**
 * Build the ingestionTaxiiEdit `input` (an array of EditInput) from canvas fields.
 * OpenCTI's generic field patch takes `value` as a list of strings. Only mutable
 * fields are patched — `name` is the identity and is not rewritten. The secret
 * `authentication_value` is only patched when the operator supplied a new one.
 * Verify the EditInput value-as-string-list shape against a live OpenCTI instance.
 */
export function buildFeedPatch(fields: Record<string, unknown>): EditInput[] {
  const patch: EditInput[] = [
    { key: 'uri', value: [String(fields.uri ?? '').trim()] },
    { key: 'collection', value: [String(fields.collection ?? '').trim()] },
    { key: 'version', value: [String(fields.version ?? '').trim()] },
    { key: 'authentication_type', value: [String(fields.authentication_type ?? '').trim()] },
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
  if (prior.authentication_type != null) patch.push({ key: 'authentication_type', value: [String(prior.authentication_type)] })
  return patch
}
