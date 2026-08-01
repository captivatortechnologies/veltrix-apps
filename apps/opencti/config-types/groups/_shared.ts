// Shared helpers for the OpenCTI Groups (RBAC) config type (deploy + rollback + drift).
//
// The GraphQL operations below follow OpenCTI conventions. OpenCTI exposes group
// edits through a nested editor mutation — `groupEdit(id) { fieldPatch(input) }` —
// rather than a top-level `groupFieldPatch`. This is the most likely shape; VERIFY
// the operation names (groupEdit vs groupFieldPatch, groupDelete vs
// groupEdit(id){delete}) and every field against a live OpenCTI instance.

/**
 * The node fields we read back on every group (list + mutation payloads).
 * NOTE: `auto_new_marking` is included so drift can compare it; the task's list
 * shape stops at `default_assignation`. Verify `auto_new_marking` is selectable.
 */
export const GROUP_NODE_FIELDS = 'id name description default_assignation auto_new_marking'

// --- GraphQL documents (verify against a live OpenCTI instance) --------------

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

/**
 * Delete one group by id — returns the deleted id. VERIFY: OpenCTI may instead
 * expose the delete under the editor as `groupEdit(id) { delete }`.
 */
export const DELETE_GROUP_MUTATION = `mutation GroupDelete($id: ID!) {
  groupDelete(id: $id)
}`

/** One OpenCTI group node. */
export interface OpenctiGroup {
  id?: string
  name?: string
  description?: string | null
  default_assignation?: boolean | null
  auto_new_marking?: boolean | null
  [key: string]: unknown
}

/** The `input` for groupAdd. */
export interface GroupAddInput {
  name: string
  description?: string
  default_assignation?: boolean
  auto_new_marking?: boolean
}

/** One EditInput entry for groupEdit.fieldPatch (`value` is a list of strings). */
export interface EditInput {
  key: string
  value: string[]
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

/** Build the groupAdd input from canvas fields. */
export function buildGroupInput(fields: Record<string, unknown>): GroupAddInput {
  const input: GroupAddInput = { name: String(fields.name ?? '').trim() }
  const description = normalizeText(fields.description)
  if (description !== undefined) input.description = description
  const defaultAssignation = normalizeBool(fields.default_assignation)
  if (defaultAssignation !== undefined) input.default_assignation = defaultAssignation
  const autoNewMarking = normalizeBool(fields.auto_new_marking)
  if (autoNewMarking !== undefined) input.auto_new_marking = autoNewMarking
  return input
}

/**
 * Build the fieldPatch `input` (an array of EditInput) from canvas fields. OpenCTI's
 * generic field patch takes `value` as a list of strings, so booleans are
 * stringified ('true'/'false'). Only mutable fields are patched — `name` is the
 * identity and is not rewritten. Verify the EditInput value-as-string-list shape
 * (and boolean-as-string) against a live OpenCTI instance.
 */
export function buildGroupPatch(fields: Record<string, unknown>): EditInput[] {
  const patch: EditInput[] = []
  const description = normalizeText(fields.description)
  if (description !== undefined) patch.push({ key: 'description', value: [description] })
  const defaultAssignation = normalizeBool(fields.default_assignation)
  if (defaultAssignation !== undefined) patch.push({ key: 'default_assignation', value: [String(defaultAssignation)] })
  const autoNewMarking = normalizeBool(fields.auto_new_marking)
  if (autoNewMarking !== undefined) patch.push({ key: 'auto_new_marking', value: [String(autoNewMarking)] })
  return patch
}

/** Build an EditInput[] that restores a prior group body (for rollback). */
export function buildRestorePatch(prior: OpenctiGroup): EditInput[] {
  const patch: EditInput[] = []
  if (prior.description != null) patch.push({ key: 'description', value: [String(prior.description)] })
  if (prior.default_assignation != null) patch.push({ key: 'default_assignation', value: [String(prior.default_assignation)] })
  if (prior.auto_new_marking != null) patch.push({ key: 'auto_new_marking', value: [String(prior.auto_new_marking)] })
  return patch
}
