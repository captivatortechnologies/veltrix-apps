// Shared helpers for the OpenCTI Marking Definitions config type (deploy + rollback + drift).
//
// Verified against the OpenCTI GraphQL backend schema (opencti-platform/opencti,
// config/schema/opencti.graphql): `markingDefinitionAdd` is a flat top-level
// mutation, but update/delete are NOT `markingDefinitionFieldPatch`/
// `markingDefinitionDelete` (those operations do not exist) — OpenCTI exposes
// them through the nested editor mutation `markingDefinitionEdit(id) {
// fieldPatch(input) / delete }`. Also, `x_opencti_order` is REQUIRED (`Int!`) on
// `MarkingDefinitionAddInput`, not optional — it must always be sent (defaulted
// to 0). Fixed here from an earlier, unverified "follow OpenCTI conventions" guess.

/** Valid OpenCTI marking-definition families exposed by this config type. */
export const MARKING_TYPES = new Set(['TLP', 'PAP', 'STATEMENT'])

/** The node fields we read back on every marking (list + mutation payloads). */
export const MARKING_NODE_FIELDS = 'id standard_id definition definition_type x_opencti_color x_opencti_order'

// --- GraphQL documents (verify against a live OpenCTI instance) --------------

/** List every marking definition (paginated `edges { node }` connection). */
export const LIST_MARKINGS_QUERY = `query MarkingDefinitions {
  markingDefinitions {
    edges { node { ${MARKING_NODE_FIELDS} } }
  }
}`

/** Create one marking definition. input: MarkingDefinitionAddInput! */
export const ADD_MARKING_MUTATION = `mutation MarkingDefinitionAdd($input: MarkingDefinitionAddInput!) {
  markingDefinitionAdd(input: $input) { ${MARKING_NODE_FIELDS} }
}`

/** Patch fields on an existing marking definition via the nested editor mutation. input: [EditInput!]! */
export const PATCH_MARKING_MUTATION = `mutation MarkingDefinitionEditFieldPatch($id: ID!, $input: [EditInput!]!) {
  markingDefinitionEdit(id: $id) {
    fieldPatch(input: $input) { ${MARKING_NODE_FIELDS} }
  }
}`

/** Delete one marking definition via the nested editor mutation — returns the deleted id. */
export const DELETE_MARKING_MUTATION = `mutation MarkingDefinitionEditDelete($id: ID!) {
  markingDefinitionEdit(id: $id) {
    delete
  }
}`

/** One OpenCTI marking definition node. */
export interface OpenctiMarking {
  id?: string
  standard_id?: string
  definition?: string
  definition_type?: string
  x_opencti_color?: string | null
  x_opencti_order?: number | null
  [key: string]: unknown
}

/** The `input` for markingDefinitionAdd. */
export interface MarkingAddInput {
  definition_type: string
  definition: string
  x_opencti_color?: string
  x_opencti_order?: number
}

/**
 * One EditInput entry for markingDefinitionEdit.fieldPatch. `value` is `[Any]`
 * in the OpenCTI schema (an unconstrained passthrough scalar) — send native
 * JSON types, never stringify booleans/numbers (confirmed against pycti, which
 * forwards raw values).
 */
export interface EditInput {
  key: string
  value: unknown[]
}

/** Unwrap an OpenCTI `{ markingDefinitions: { edges: [{ node }] } }` connection into a flat array. */
export function markingsFromList(data: unknown): OpenctiMarking[] {
  const edges = (data as { markingDefinitions?: { edges?: Array<{ node?: OpenctiMarking }> } } | null | undefined)
    ?.markingDefinitions?.edges
  if (!Array.isArray(edges)) return []
  return edges.map((e) => e?.node).filter((n): n is OpenctiMarking => !!n)
}

/** Find a live marking by its `definition` value (case-insensitive — the stable identity). */
export function findMarking(markings: OpenctiMarking[], definition: string): OpenctiMarking | null {
  const d = definition.trim().toLowerCase()
  if (!d) return null
  return markings.find((m) => String(m.definition ?? '').trim().toLowerCase() === d) ?? null
}

/** Coerce a canvas order field to a non-negative integer (undefined when blank). */
export function normalizeOrder(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : undefined
}

/** Trim a hex color (undefined when blank). */
export function normalizeColor(value: unknown): string | undefined {
  const s = String(value ?? '').trim()
  return s === '' ? undefined : s
}

/**
 * Build the markingDefinitionAdd input from canvas fields. `x_opencti_order` is
 * REQUIRED (`Int!`) on `MarkingDefinitionAddInput` — always send it, defaulting
 * to 0 when the canvas field is blank, rather than omitting it.
 */
export function buildMarkingInput(fields: Record<string, unknown>): MarkingAddInput {
  const input: MarkingAddInput = {
    definition_type: String(fields.definition_type ?? '').trim(),
    definition: String(fields.definition ?? '').trim(),
    x_opencti_order: normalizeOrder(fields.x_opencti_order) ?? 0,
  }
  const color = normalizeColor(fields.x_opencti_color)
  if (color !== undefined) input.x_opencti_color = color
  return input
}

/**
 * Build the markingDefinitionEdit.fieldPatch `input` (an array of EditInput)
 * from canvas fields. `value` is `[Any]` — numbers are sent as native numbers,
 * not stringified. Only the mutable presentation/type fields are patched —
 * `definition` is the identity and is not rewritten.
 */
export function buildMarkingPatch(fields: Record<string, unknown>): EditInput[] {
  const patch: EditInput[] = [{ key: 'definition_type', value: [String(fields.definition_type ?? '').trim()] }]
  const color = normalizeColor(fields.x_opencti_color)
  if (color !== undefined) patch.push({ key: 'x_opencti_color', value: [color] })
  const order = normalizeOrder(fields.x_opencti_order)
  patch.push({ key: 'x_opencti_order', value: [order ?? 0] })
  return patch
}

/** Build an EditInput[] that restores a prior marking body (for rollback). */
export function buildRestorePatch(prior: OpenctiMarking): EditInput[] {
  const patch: EditInput[] = []
  if (prior.definition_type != null) patch.push({ key: 'definition_type', value: [String(prior.definition_type)] })
  if (prior.x_opencti_color != null) patch.push({ key: 'x_opencti_color', value: [String(prior.x_opencti_color)] })
  if (prior.x_opencti_order != null) patch.push({ key: 'x_opencti_order', value: [prior.x_opencti_order] })
  return patch
}
