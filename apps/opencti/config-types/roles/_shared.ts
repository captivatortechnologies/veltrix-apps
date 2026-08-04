// Shared helpers for the OpenCTI Roles (RBAC) config type (deploy + rollback + drift).
//
// Operations verified against the OpenCTI GraphQL backend schema
// (opencti-platform/opencti, config/schema/opencti.graphql), type `Role`. OpenCTI
// exposes role edits through a nested editor mutation — `roleEdit(id) {
// fieldPatch(input) }` — same shape as Group/MarkingDefinition, not a top-level
// `roleFieldPatch`.
//
// OUT OF SCOPE: capability assignment. Capabilities are attached to a role via
// `roleEdit(id) { relationAdd }`, an internal relationship whose
// `relationship_type` string isn't documented at the schema level the way typed
// `*AddInput`s are — this config type manages only the role's name/description,
// not what it can do. A dedicated "role capabilities" type is a candidate
// follow-up once that relationship shape is verified.

/** The node fields we read back on every role (list + mutation payloads). */
export const ROLE_NODE_FIELDS = 'id name description'

// --- GraphQL documents --------------------------------------------------------

/** List every role (paginated `edges { node }` connection). NOTE: `roles` takes no `filters` arg. */
export const LIST_ROLES_QUERY = `query Roles {
  roles {
    edges { node { ${ROLE_NODE_FIELDS} } }
  }
}`

/** Create one role. input: RoleAddInput! */
export const ADD_ROLE_MUTATION = `mutation RoleAdd($input: RoleAddInput!) {
  roleAdd(input: $input) { ${ROLE_NODE_FIELDS} }
}`

/** Patch fields on an existing role via the nested editor mutation. input: [EditInput!]! */
export const PATCH_ROLE_MUTATION = `mutation RoleEdit($id: ID!, $input: [EditInput!]!) {
  roleEdit(id: $id) {
    fieldPatch(input: $input) { ${ROLE_NODE_FIELDS} }
  }
}`

/** Delete one role via the nested editor mutation — returns the deleted id. */
export const DELETE_ROLE_MUTATION = `mutation RoleDelete($id: ID!) {
  roleEdit(id: $id) {
    delete
  }
}`

/** One OpenCTI role node. */
export interface OpenctiRole {
  id?: string
  name?: string
  description?: string | null
  [key: string]: unknown
}

/** The `input` for roleAdd. */
export interface RoleAddInput {
  name: string
  description?: string
}

/** One EditInput entry for roleEdit.fieldPatch. `value` is `[Any]!` — send native JS values, never stringify. */
export interface EditInput {
  key: string
  value: unknown[]
}

/** Unwrap an OpenCTI `{ roles: { edges: [{ node }] } }` connection into a flat array. */
export function rolesFromList(data: unknown): OpenctiRole[] {
  const edges = (data as { roles?: { edges?: Array<{ node?: OpenctiRole }> } } | null | undefined)?.roles?.edges
  if (!Array.isArray(edges)) return []
  return edges.map((e) => e?.node).filter((n): n is OpenctiRole => !!n)
}

/** Find a live role by its `name` (case-insensitive — the stable identity). */
export function findRole(roles: OpenctiRole[], name: string): OpenctiRole | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return roles.find((r) => String(r.name ?? '').trim().toLowerCase() === n) ?? null
}

/** Trim a description (undefined when blank). */
export function normalizeText(value: unknown): string | undefined {
  const s = String(value ?? '').trim()
  return s === '' ? undefined : s
}

/** Build the roleAdd input from canvas fields. */
export function buildRoleInput(fields: Record<string, unknown>): RoleAddInput {
  const input: RoleAddInput = { name: String(fields.name ?? '').trim() }
  const description = normalizeText(fields.description)
  if (description !== undefined) input.description = description
  return input
}

/**
 * Build the roleEdit.fieldPatch `input` (an array of EditInput) from canvas
 * fields. Only the mutable presentation field is patched — `name` is the
 * identity and is not rewritten.
 */
export function buildRolePatch(fields: Record<string, unknown>): EditInput[] {
  const patch: EditInput[] = []
  const description = normalizeText(fields.description)
  if (description !== undefined) patch.push({ key: 'description', value: [description] })
  return patch
}

/** Build an EditInput[] that restores a prior role body (for rollback). */
export function buildRestorePatch(prior: OpenctiRole): EditInput[] {
  const patch: EditInput[] = []
  if (prior.description != null) patch.push({ key: 'description', value: [String(prior.description)] })
  return patch
}
