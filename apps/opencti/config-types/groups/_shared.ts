// Shared helpers for the OpenCTI Groups (RBAC) config type (deploy + rollback + drift).
//
// Verified against the OpenCTI GraphQL backend schema (opencti-platform/opencti,
// config/schema/opencti.graphql). Two corrections from an earlier, unverified
// "follow OpenCTI conventions" guess:
//   1. Delete is NOT a top-level `groupDelete(id)` — that operation does not
//      exist. Both fieldPatch AND delete live under the nested editor mutation
//      `groupEdit(id) { fieldPatch(input) / delete }`.
//   2. `GroupAddInput` REQUIRES `group_confidence_level: ConfidenceLevelInput!`
//      (`{ max_confidence: Int, overrides: [ConfidenceLevelOverrideInput!]! }`).
//      Omitting it (as the earlier version did) fails schema validation on every
//      create. The per-entity-type `overrides` list is out of scope for this
//      declarative surface — always sent as `[]`; only the scalar
//      `max_confidence` ceiling is exposed as a canvas field.

/**
 * The node fields we read back on every group (list + mutation payloads).
 * `group_confidence_level` selects only `max_confidence` — `overrides` is never
 * read back or diffed (out of scope, see above).
 */
export const GROUP_NODE_FIELDS =
  'id name description default_assignation auto_new_marking group_confidence_level { max_confidence }'

// --- GraphQL documents (verified against the OpenCTI backend schema) --------

/** List every group (paginated `edges { node }` connection). */
export const LIST_GROUPS_QUERY = `query Groups {
  groups {
    edges { node { ${GROUP_NODE_FIELDS} } }
  }
}`

/** Create one group. input: GroupAddInput! */
export const ADD_GROUP_MUTATION = `mutation GroupAdd($input: GroupAddInput!) {
  groupAdd(input: $input) { ${GROUP_NODE_FIELDS} }
}`

/**
 * Patch fields on an existing group via the nested editor mutation. VERIFY: OpenCTI
 * may instead expose a top-level `groupFieldPatch(id, input)`. input: [EditInput!]!
 */
export const PATCH_GROUP_MUTATION = `mutation GroupEdit($id: ID!, $input: [EditInput!]!) {
  groupEdit(id: $id) {
    fieldPatch(input: $input) { ${GROUP_NODE_FIELDS} }
  }
}`

/** Delete one group via the nested editor mutation — returns the deleted id. */
export const DELETE_GROUP_MUTATION = `mutation GroupEditDelete($id: ID!) {
  groupEdit(id: $id) {
    delete
  }
}`

/** A `ConfidenceLevel`/`ConfidenceLevelInput` restricted to the scalar ceiling we manage. */
export interface GroupConfidenceLevel {
  max_confidence?: number | null
}

/** One OpenCTI group node. */
export interface OpenctiGroup {
  id?: string
  name?: string
  description?: string | null
  default_assignation?: boolean | null
  auto_new_marking?: boolean | null
  group_confidence_level?: GroupConfidenceLevel | null
  [key: string]: unknown
}

/** The `input` for groupAdd. `group_confidence_level` is required by the schema. */
export interface GroupAddInput {
  name: string
  description?: string
  default_assignation?: boolean
  auto_new_marking?: boolean
  group_confidence_level: { max_confidence: number | null; overrides: [] }
}

/**
 * One EditInput entry for groupEdit.fieldPatch. `value` is `[Any]` in the OpenCTI
 * schema (an unconstrained passthrough scalar) — send native JSON types, never
 * stringify booleans/numbers (confirmed against pycti, which forwards raw
 * values). An object-valued attribute like `group_confidence_level` is patched
 * as a single-element array containing the object.
 */
export interface EditInput {
  key: string
  value: unknown[]
}

/** Unwrap an OpenCTI `{ groups: { edges: [{ node }] } }` connection into a flat array. */
export function groupsFromList(data: unknown): OpenctiGroup[] {
  const edges = (data as { groups?: { edges?: Array<{ node?: OpenctiGroup }> } } | null | undefined)?.groups?.edges
  if (!Array.isArray(edges)) return []
  return edges.map((e) => e?.node).filter((n): n is OpenctiGroup => !!n)
}

/** Find a live group by its `name` (case-insensitive — the stable identity). */
export function findGroup(groups: OpenctiGroup[], name: string): OpenctiGroup | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return groups.find((g) => String(g.name ?? '').trim().toLowerCase() === n) ?? null
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

/** Trim a description (undefined when blank). */
export function normalizeText(value: unknown): string | undefined {
  const s = String(value ?? '').trim()
  return s === '' ? undefined : s
}

/** Coerce a canvas number field to a confidence ceiling (null when blank — no ceiling). */
export function normalizeConfidenceLevel(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/**
 * Build the groupAdd input from canvas fields. `group_confidence_level` is
 * REQUIRED by the schema — always sent, with an empty `overrides` list (the
 * per-entity-type override table is out of scope for this declarative surface).
 */
export function buildGroupInput(fields: Record<string, unknown>): GroupAddInput {
  const input: GroupAddInput = {
    name: String(fields.name ?? '').trim(),
    group_confidence_level: { max_confidence: normalizeConfidenceLevel(fields.confidence_level_max), overrides: [] },
  }
  const description = normalizeText(fields.description)
  if (description !== undefined) input.description = description
  const defaultAssignation = normalizeBool(fields.default_assignation)
  if (defaultAssignation !== undefined) input.default_assignation = defaultAssignation
  const autoNewMarking = normalizeBool(fields.auto_new_marking)
  if (autoNewMarking !== undefined) input.auto_new_marking = autoNewMarking
  return input
}

/**
 * Build the groupEdit.fieldPatch `input` (an array of EditInput) from canvas
 * fields. `value` is `[Any]` — booleans are sent as native booleans, never
 * stringified. Only mutable fields are patched — `name` is the identity and is
 * not rewritten. `group_confidence_level` is an object-valued attribute, patched
 * as a single-element array containing the object.
 */
export function buildGroupPatch(fields: Record<string, unknown>): EditInput[] {
  const patch: EditInput[] = []
  const description = normalizeText(fields.description)
  if (description !== undefined) patch.push({ key: 'description', value: [description] })
  const defaultAssignation = normalizeBool(fields.default_assignation)
  if (defaultAssignation !== undefined) patch.push({ key: 'default_assignation', value: [defaultAssignation] })
  const autoNewMarking = normalizeBool(fields.auto_new_marking)
  if (autoNewMarking !== undefined) patch.push({ key: 'auto_new_marking', value: [autoNewMarking] })
  patch.push({
    key: 'group_confidence_level',
    value: [{ max_confidence: normalizeConfidenceLevel(fields.confidence_level_max), overrides: [] }],
  })
  return patch
}

/** Build an EditInput[] that restores a prior group body (for rollback). */
export function buildRestorePatch(prior: OpenctiGroup): EditInput[] {
  const patch: EditInput[] = []
  if (prior.description != null) patch.push({ key: 'description', value: [String(prior.description)] })
  if (prior.default_assignation != null) patch.push({ key: 'default_assignation', value: [prior.default_assignation] })
  if (prior.auto_new_marking != null) patch.push({ key: 'auto_new_marking', value: [prior.auto_new_marking] })
  patch.push({
    key: 'group_confidence_level',
    value: [{ max_confidence: prior.group_confidence_level?.max_confidence ?? null, overrides: [] }],
  })
  return patch
}
