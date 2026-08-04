// Shared helpers for the OpenCTI Stream Collections config type
// (deploy + rollback + drift).
//
// The GraphQL operations below (streamCollectionAdd, streamCollectionEdit.
// fieldPatch, streamCollectionEdit.delete) are verified against the OpenCTI
// GraphQL backend schema (opencti-platform/opencti,
// src/modules/dataSharing/streamCollection.graphql). OpenCTI exposes stream
// collection edits through a nested editor mutation — `streamCollectionEdit(id)
// { fieldPatch(input) / delete }` — same shape as Group/Role/RetentionRule, not
// a top-level `streamCollectionFieldPatch`.
//
// OUT OF SCOPE: `stream_public_user_id`/`authorized_members` on create (user-id
// / ACL wiring), and `streamCollectionEdit(id).addGroup`/`.deleteGroup`
// (group-sharing) — this type manages the stream's own identity, live/public
// state and filters only.

/** The node fields we read back on every stream collection (list + mutation payloads). */
export const STREAM_COLLECTION_NODE_FIELDS = 'id name description filters origin_filters stream_live stream_public'

// --- GraphQL documents --------------------------------------------------------

/** List every stream collection (paginated `edges { node }` connection). */
export const LIST_STREAM_COLLECTIONS_QUERY = `query StreamCollections {
  streamCollections {
    edges { node { ${STREAM_COLLECTION_NODE_FIELDS} } }
  }
}`

/** Create one stream collection. input: StreamCollectionAddInput! */
export const ADD_STREAM_COLLECTION_MUTATION = `mutation StreamCollectionAdd($input: StreamCollectionAddInput!) {
  streamCollectionAdd(input: $input) { ${STREAM_COLLECTION_NODE_FIELDS} }
}`

/** Patch fields on an existing stream collection via the nested editor mutation. input: [EditInput!]! */
export const PATCH_STREAM_COLLECTION_MUTATION = `mutation StreamCollectionEdit($id: ID!, $input: [EditInput!]!) {
  streamCollectionEdit(id: $id) {
    fieldPatch(input: $input) { ${STREAM_COLLECTION_NODE_FIELDS} }
  }
}`

/** Delete one stream collection via the nested editor mutation — returns the deleted id. */
export const DELETE_STREAM_COLLECTION_MUTATION = `mutation StreamCollectionDelete($id: ID!) {
  streamCollectionEdit(id: $id) {
    delete
  }
}`

/** One OpenCTI stream collection node. */
export interface OpenctiStreamCollection {
  id?: string
  name?: string
  description?: string | null
  filters?: string | null
  origin_filters?: string | null
  stream_live?: boolean | null
  stream_public?: boolean | null
  [key: string]: unknown
}

/** The `input` for streamCollectionAdd. */
export interface StreamCollectionAddInput {
  name: string
  description?: string
  filters?: string
  origin_filters?: string
  stream_live?: boolean
  stream_public?: boolean
}

/**
 * One EditInput entry for streamCollectionEdit.fieldPatch. `value` is `[Any]!`
 * on the OpenCTI backend — send native JS values, never stringify
 * booleans/numbers.
 */
export interface EditInput {
  key: string
  value: unknown[]
}

/** Unwrap an OpenCTI `{ streamCollections: { edges: [{ node }] } }` connection into a flat array. */
export function streamCollectionsFromList(data: unknown): OpenctiStreamCollection[] {
  const edges = (data as { streamCollections?: { edges?: Array<{ node?: OpenctiStreamCollection }> } } | null | undefined)
    ?.streamCollections?.edges
  if (!Array.isArray(edges)) return []
  return edges.map((e) => e?.node).filter((n): n is OpenctiStreamCollection => !!n)
}

/** Find a live stream collection by its `name` (case-insensitive — the stable identity). */
export function findStreamCollection(collections: OpenctiStreamCollection[], name: string): OpenctiStreamCollection | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return collections.find((c) => String(c.name ?? '').trim().toLowerCase() === n) ?? null
}

/** Trim a string field (undefined when blank). */
export function normalizeText(value: unknown): string | undefined {
  const s = String(value ?? '').trim()
  return s === '' ? undefined : s
}

/** Coerce a canvas checkbox field to a boolean (undefined when blank). */
export function normalizeBool(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'boolean') return value
  const s = String(value).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes') return true
  if (s === 'false' || s === '0' || s === 'no') return false
  return undefined
}

/** Build the streamCollectionAdd input from canvas fields. */
export function buildStreamCollectionInput(fields: Record<string, unknown>): StreamCollectionAddInput {
  const input: StreamCollectionAddInput = { name: String(fields.name ?? '').trim() }
  const description = normalizeText(fields.description)
  if (description !== undefined) input.description = description
  const filters = normalizeText(fields.filters)
  if (filters !== undefined) input.filters = filters
  const originFilters = normalizeText(fields.origin_filters)
  if (originFilters !== undefined) input.origin_filters = originFilters
  const streamLive = normalizeBool(fields.stream_live)
  if (streamLive !== undefined) input.stream_live = streamLive
  const streamPublic = normalizeBool(fields.stream_public)
  if (streamPublic !== undefined) input.stream_public = streamPublic
  return input
}

/**
 * Build the streamCollectionEdit.fieldPatch `input` (an array of EditInput)
 * from canvas fields. Only mutable fields are patched — `name` is the identity
 * and is not rewritten.
 */
export function buildStreamCollectionPatch(fields: Record<string, unknown>): EditInput[] {
  const patch: EditInput[] = []
  const description = normalizeText(fields.description)
  if (description !== undefined) patch.push({ key: 'description', value: [description] })
  const filters = normalizeText(fields.filters)
  if (filters !== undefined) patch.push({ key: 'filters', value: [filters] })
  const originFilters = normalizeText(fields.origin_filters)
  if (originFilters !== undefined) patch.push({ key: 'origin_filters', value: [originFilters] })
  const streamLive = normalizeBool(fields.stream_live)
  if (streamLive !== undefined) patch.push({ key: 'stream_live', value: [streamLive] })
  const streamPublic = normalizeBool(fields.stream_public)
  if (streamPublic !== undefined) patch.push({ key: 'stream_public', value: [streamPublic] })
  return patch
}

/** Build an EditInput[] that restores a prior stream collection body (for rollback). */
export function buildRestorePatch(prior: OpenctiStreamCollection): EditInput[] {
  const patch: EditInput[] = []
  if (prior.description != null) patch.push({ key: 'description', value: [prior.description] })
  if (prior.filters != null) patch.push({ key: 'filters', value: [prior.filters] })
  if (prior.origin_filters != null) patch.push({ key: 'origin_filters', value: [prior.origin_filters] })
  if (prior.stream_live != null) patch.push({ key: 'stream_live', value: [prior.stream_live] })
  if (prior.stream_public != null) patch.push({ key: 'stream_public', value: [prior.stream_public] })
  return patch
}
