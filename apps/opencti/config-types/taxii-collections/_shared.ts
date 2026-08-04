// Shared helpers for the OpenCTI TAXII Collections config type
// (deploy + rollback + drift).
//
// The GraphQL operations below (taxiiCollectionAdd, taxiiCollectionEdit.
// fieldPatch, taxiiCollectionEdit.delete) are verified against the OpenCTI
// GraphQL backend schema (opencti-platform/opencti,
// src/modules/dataSharing/taxiiCollection.graphql). OpenCTI exposes TAXII
// collection edits through a nested editor mutation — `taxiiCollectionEdit(id)
// { fieldPatch(input) / delete }` — same shape as Group/Role/StreamCollection,
// not a top-level `taxiiCollectionFieldPatch`.
//
// OUT OF SCOPE: `taxii_public_user_id`/`authorized_members` on create (user-id
// / ACL wiring) — this type manages the collection's own identity, exposure
// options and filters only.

/** The node fields we read back on every TAXII collection (list + mutation payloads). */
export const TAXII_COLLECTION_NODE_FIELDS = 'id name description filters include_inferences score_to_confidence taxii_public'

// --- GraphQL documents --------------------------------------------------------

/** List every TAXII collection (paginated `edges { node }` connection). */
export const LIST_TAXII_COLLECTIONS_QUERY = `query TaxiiCollections {
  taxiiCollections {
    edges { node { ${TAXII_COLLECTION_NODE_FIELDS} } }
  }
}`

/** Create one TAXII collection. input: TaxiiCollectionAddInput! */
export const ADD_TAXII_COLLECTION_MUTATION = `mutation TaxiiCollectionAdd($input: TaxiiCollectionAddInput!) {
  taxiiCollectionAdd(input: $input) { ${TAXII_COLLECTION_NODE_FIELDS} }
}`

/** Patch fields on an existing TAXII collection via the nested editor mutation. input: [EditInput!]! */
export const PATCH_TAXII_COLLECTION_MUTATION = `mutation TaxiiCollectionEdit($id: ID!, $input: [EditInput!]!) {
  taxiiCollectionEdit(id: $id) {
    fieldPatch(input: $input) { ${TAXII_COLLECTION_NODE_FIELDS} }
  }
}`

/** Delete one TAXII collection via the nested editor mutation — returns the deleted id. */
export const DELETE_TAXII_COLLECTION_MUTATION = `mutation TaxiiCollectionDelete($id: ID!) {
  taxiiCollectionEdit(id: $id) {
    delete
  }
}`

/** One OpenCTI TAXII collection node. */
export interface OpenctiTaxiiCollection {
  id?: string
  name?: string
  description?: string | null
  filters?: string | null
  include_inferences?: boolean | null
  score_to_confidence?: boolean | null
  taxii_public?: boolean | null
  [key: string]: unknown
}

/** The `input` for taxiiCollectionAdd. */
export interface TaxiiCollectionAddInput {
  name: string
  description?: string
  filters?: string
  taxii_public?: boolean
  include_inferences?: boolean
  score_to_confidence?: boolean
}

/**
 * One EditInput entry for taxiiCollectionEdit.fieldPatch. `value` is `[Any]!`
 * on the OpenCTI backend — send native JS values, never stringify
 * booleans/numbers.
 */
export interface EditInput {
  key: string
  value: unknown[]
}

/** Unwrap an OpenCTI `{ taxiiCollections: { edges: [{ node }] } }` connection into a flat array. */
export function taxiiCollectionsFromList(data: unknown): OpenctiTaxiiCollection[] {
  const edges = (data as { taxiiCollections?: { edges?: Array<{ node?: OpenctiTaxiiCollection }> } } | null | undefined)
    ?.taxiiCollections?.edges
  if (!Array.isArray(edges)) return []
  return edges.map((e) => e?.node).filter((n): n is OpenctiTaxiiCollection => !!n)
}

/** Find a live TAXII collection by its `name` (case-insensitive — the stable identity). */
export function findTaxiiCollection(collections: OpenctiTaxiiCollection[], name: string): OpenctiTaxiiCollection | null {
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

/** Build the taxiiCollectionAdd input from canvas fields. */
export function buildTaxiiCollectionInput(fields: Record<string, unknown>): TaxiiCollectionAddInput {
  const input: TaxiiCollectionAddInput = { name: String(fields.name ?? '').trim() }
  const description = normalizeText(fields.description)
  if (description !== undefined) input.description = description
  const filters = normalizeText(fields.filters)
  if (filters !== undefined) input.filters = filters
  const taxiiPublic = normalizeBool(fields.taxii_public)
  if (taxiiPublic !== undefined) input.taxii_public = taxiiPublic
  const includeInferences = normalizeBool(fields.include_inferences)
  if (includeInferences !== undefined) input.include_inferences = includeInferences
  const scoreToConfidence = normalizeBool(fields.score_to_confidence)
  if (scoreToConfidence !== undefined) input.score_to_confidence = scoreToConfidence
  return input
}

/**
 * Build the taxiiCollectionEdit.fieldPatch `input` (an array of EditInput)
 * from canvas fields. Only mutable fields are patched — `name` is the
 * identity and is not rewritten.
 */
export function buildTaxiiCollectionPatch(fields: Record<string, unknown>): EditInput[] {
  const patch: EditInput[] = []
  const description = normalizeText(fields.description)
  if (description !== undefined) patch.push({ key: 'description', value: [description] })
  const filters = normalizeText(fields.filters)
  if (filters !== undefined) patch.push({ key: 'filters', value: [filters] })
  const taxiiPublic = normalizeBool(fields.taxii_public)
  if (taxiiPublic !== undefined) patch.push({ key: 'taxii_public', value: [taxiiPublic] })
  const includeInferences = normalizeBool(fields.include_inferences)
  if (includeInferences !== undefined) patch.push({ key: 'include_inferences', value: [includeInferences] })
  const scoreToConfidence = normalizeBool(fields.score_to_confidence)
  if (scoreToConfidence !== undefined) patch.push({ key: 'score_to_confidence', value: [scoreToConfidence] })
  return patch
}

/** Build an EditInput[] that restores a prior TAXII collection body (for rollback). */
export function buildRestorePatch(prior: OpenctiTaxiiCollection): EditInput[] {
  const patch: EditInput[] = []
  if (prior.description != null) patch.push({ key: 'description', value: [prior.description] })
  if (prior.filters != null) patch.push({ key: 'filters', value: [prior.filters] })
  if (prior.taxii_public != null) patch.push({ key: 'taxii_public', value: [prior.taxii_public] })
  if (prior.include_inferences != null) patch.push({ key: 'include_inferences', value: [prior.include_inferences] })
  if (prior.score_to_confidence != null) patch.push({ key: 'score_to_confidence', value: [prior.score_to_confidence] })
  return patch
}
