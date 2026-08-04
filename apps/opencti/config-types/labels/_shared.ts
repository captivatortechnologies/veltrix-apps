// Shared helpers for the OpenCTI Labels config type (deploy + rollback + drift).
//
// Verified against the OpenCTI GraphQL backend schema (opencti-platform/opencti,
// config/schema/opencti.graphql): `labelAdd` is a flat top-level mutation, but
// update/delete are NOT `labelFieldPatch`/`labelDelete` (those operations do not
// exist) — OpenCTI exposes them through the nested editor mutation
// `labelEdit(id) { fieldPatch(input) / delete }`. Fixed here from an earlier,
// unverified "follow OpenCTI conventions" guess.

/** The node fields we read back on every label (list + mutation payloads). */
export const LABEL_NODE_FIELDS = 'id value color'

// --- GraphQL documents (verified against the OpenCTI backend schema) --------

/** List every label (paginated `edges { node }` connection). */
export const LIST_LABELS_QUERY = `query Labels {
  labels {
    edges { node { ${LABEL_NODE_FIELDS} } }
  }
}`

/** Create one label. input: LabelAddInput! */
export const ADD_LABEL_MUTATION = `mutation LabelAdd($input: LabelAddInput!) {
  labelAdd(input: $input) { ${LABEL_NODE_FIELDS} }
}`

/** Patch fields on an existing label via the nested editor mutation. input: [EditInput!]! */
export const PATCH_LABEL_MUTATION = `mutation LabelEditFieldPatch($id: ID!, $input: [EditInput!]!) {
  labelEdit(id: $id) {
    fieldPatch(input: $input) { ${LABEL_NODE_FIELDS} }
  }
}`

/** Delete one label via the nested editor mutation — returns the deleted id. */
export const DELETE_LABEL_MUTATION = `mutation LabelEditDelete($id: ID!) {
  labelEdit(id: $id) {
    delete
  }
}`

/** One OpenCTI label node. */
export interface OpenctiLabel {
  id?: string
  value?: string
  color?: string | null
  [key: string]: unknown
}

/** The `input` for labelAdd. */
export interface LabelAddInput {
  value: string
  color?: string
}

/**
 * One EditInput entry for labelEdit.fieldPatch. `value` is `[Any]` in the OpenCTI
 * schema (an unconstrained passthrough scalar) — send native JSON types, never
 * stringify booleans/numbers (confirmed against pycti, which forwards raw values).
 */
export interface EditInput {
  key: string
  value: unknown[]
}

/** Unwrap an OpenCTI `{ labels: { edges: [{ node }] } }` connection into a flat array. */
export function labelsFromList(data: unknown): OpenctiLabel[] {
  const edges = (data as { labels?: { edges?: Array<{ node?: OpenctiLabel }> } } | null | undefined)?.labels?.edges
  if (!Array.isArray(edges)) return []
  return edges.map((e) => e?.node).filter((n): n is OpenctiLabel => !!n)
}

/** Find a live label by its `value` (case-insensitive — the stable identity). */
export function findLabel(labels: OpenctiLabel[], value: string): OpenctiLabel | null {
  const v = value.trim().toLowerCase()
  if (!v) return null
  return labels.find((l) => String(l.value ?? '').trim().toLowerCase() === v) ?? null
}

/** Trim a hex color (undefined when blank). */
export function normalizeColor(value: unknown): string | undefined {
  const s = String(value ?? '').trim()
  return s === '' ? undefined : s
}

/** Build the labelAdd input from canvas fields. */
export function buildLabelInput(fields: Record<string, unknown>): LabelAddInput {
  const input: LabelAddInput = { value: String(fields.value ?? '').trim() }
  const color = normalizeColor(fields.color)
  if (color !== undefined) input.color = color
  return input
}

/**
 * Build the labelFieldPatch `input` (an array of EditInput) from canvas fields.
 * OpenCTI's generic field patch takes `value` as a list of strings. Only the
 * mutable presentation field is patched — `value` is the identity and is not
 * rewritten. Verify the EditInput value-as-string-list shape against a live
 * OpenCTI instance.
 */
export function buildLabelPatch(fields: Record<string, unknown>): EditInput[] {
  const patch: EditInput[] = []
  const color = normalizeColor(fields.color)
  if (color !== undefined) patch.push({ key: 'color', value: [color] })
  return patch
}

/** Build an EditInput[] that restores a prior label body (for rollback). */
export function buildRestorePatch(prior: OpenctiLabel): EditInput[] {
  const patch: EditInput[] = []
  if (prior.color != null) patch.push({ key: 'color', value: [String(prior.color)] })
  return patch
}
