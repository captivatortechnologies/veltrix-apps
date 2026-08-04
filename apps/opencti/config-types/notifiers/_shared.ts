// Shared helpers for the OpenCTI Notifiers config type (deploy + rollback +
// drift).
//
// The GraphQL operations below (notifierAdd, notifierFieldPatch,
// notifierDelete) are verified against the OpenCTI GraphQL backend schema
// (opencti-platform/opencti, src/modules/notifier/notifier.graphql).
//
// Referenced by the sibling notification-triggers config type
// (`triggerKnowledgeLiveAdd`'s `notifiers: [StixRef!]` field) — that type
// looks up a notifier's live id by matching this type's `name`.

/** The node fields we read back on every notifier (list + mutation payloads). */
export const NOTIFIER_NODE_FIELDS = 'id name description notifier_connector_id notifier_configuration'

// --- GraphQL documents --------------------------------------------------------

/** List every notifier (paginated `edges { node }` connection). */
export const LIST_NOTIFIERS_QUERY = `query Notifiers {
  notifiers {
    edges { node { ${NOTIFIER_NODE_FIELDS} } }
  }
}`

/**
 * Create one notifier. input: NotifierAddInput! `authorized_members` (member-id
 * ACL wiring) is intentionally out of scope and never sent.
 */
export const ADD_NOTIFIER_MUTATION = `mutation NotifierAdd($input: NotifierAddInput!) {
  notifierAdd(input: $input) { ${NOTIFIER_NODE_FIELDS} }
}`

/** Patch fields on an existing notifier. input: [EditInput!]! */
export const PATCH_NOTIFIER_MUTATION = `mutation NotifierFieldPatch($id: ID!, $input: [EditInput!]!) {
  notifierFieldPatch(id: $id, input: $input) { ${NOTIFIER_NODE_FIELDS} }
}`

/** Delete one notifier by id — returns the deleted id. */
export const DELETE_NOTIFIER_MUTATION = `mutation NotifierDelete($id: ID!) {
  notifierDelete(id: $id)
}`

/** One OpenCTI notifier node. */
export interface OpenctiNotifier {
  id?: string
  name?: string
  description?: string | null
  notifier_connector_id?: string
  notifier_configuration?: string
  [key: string]: unknown
}

/** The `input` for notifierAdd. `authorized_members` is out of scope (ACL wiring). */
export interface NotifierAddInput {
  name: string
  description?: string
  notifier_connector_id: string
  notifier_configuration: string
}

/**
 * One EditInput entry for notifierFieldPatch. `value` is `[Any]!` on the
 * OpenCTI backend — send native JS values, never stringify booleans/numbers.
 */
export interface EditInput {
  key: string
  value: unknown[]
}

/** Unwrap an OpenCTI `{ notifiers: { edges: [{ node }] } }` connection into a flat array. */
export function notifiersFromList(data: unknown): OpenctiNotifier[] {
  const edges = (data as { notifiers?: { edges?: Array<{ node?: OpenctiNotifier }> } } | null | undefined)?.notifiers?.edges
  if (!Array.isArray(edges)) return []
  return edges.map((e) => e?.node).filter((n): n is OpenctiNotifier => !!n)
}

/** Find a live notifier by its `name` (case-insensitive — the stable identity). */
export function findNotifier(notifiers: OpenctiNotifier[], name: string): OpenctiNotifier | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return notifiers.find((v) => String(v.name ?? '').trim().toLowerCase() === n) ?? null
}

/** Trim a string field (undefined when blank). */
export function normalizeText(value: unknown): string | undefined {
  const s = String(value ?? '').trim()
  return s === '' ? undefined : s
}

/** Build the notifierAdd input from canvas fields. */
export function buildNotifierInput(fields: Record<string, unknown>): NotifierAddInput {
  const input: NotifierAddInput = {
    name: String(fields.name ?? '').trim(),
    notifier_connector_id: String(fields.notifier_connector_id ?? '').trim(),
    notifier_configuration: String(fields.notifier_configuration ?? '').trim(),
  }
  const description = normalizeText(fields.description)
  if (description !== undefined) input.description = description
  return input
}

/**
 * Build the notifierFieldPatch `input` (an array of EditInput) from canvas
 * fields. Only mutable fields are patched — `name` is the identity and is not
 * rewritten.
 */
export function buildNotifierPatch(fields: Record<string, unknown>): EditInput[] {
  const patch: EditInput[] = [
    { key: 'notifier_connector_id', value: [String(fields.notifier_connector_id ?? '').trim()] },
    { key: 'notifier_configuration', value: [String(fields.notifier_configuration ?? '').trim()] },
  ]
  const description = normalizeText(fields.description)
  if (description !== undefined) patch.push({ key: 'description', value: [description] })
  return patch
}

/** Build an EditInput[] that restores a prior notifier body (for rollback). */
export function buildRestorePatch(prior: OpenctiNotifier): EditInput[] {
  const patch: EditInput[] = []
  if (prior.notifier_connector_id != null) patch.push({ key: 'notifier_connector_id', value: [String(prior.notifier_connector_id)] })
  if (prior.notifier_configuration != null) patch.push({ key: 'notifier_configuration', value: [String(prior.notifier_configuration)] })
  if (prior.description != null) patch.push({ key: 'description', value: [String(prior.description)] })
  return patch
}
