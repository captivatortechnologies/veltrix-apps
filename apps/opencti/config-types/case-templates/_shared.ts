// Shared helpers for the OpenCTI Case Templates config type
// (deploy + rollback + drift).
//
// The GraphQL operations below (caseTemplateAdd, caseTemplateFieldPatch,
// caseTemplateDelete) are verified against the OpenCTI GraphQL backend schema
// (opencti-platform/opencti, src/modules/case/case-template/case-template.graphql).
//
// A case template's `tasks` field is `[StixRef!]!` — internal ids of Case Task
// Templates (the sibling config type at config-types/case-task-templates/), NOT
// names. This type has no cross-import into that sibling directory (config
// types are self-contained); instead it runs its own minimal `taskTemplates`
// list query to resolve the canvas's `task_template_names` into live ids,
// exactly the read-then-match pattern this app already uses everywhere else.
//
// UNVERIFIED (flagged honestly): `tasks` is a plain array field on
// `CaseTemplateAddInput`, so this type assumes it is also patchable via a
// normal EditInput (`{ key: 'tasks', value: [id1, id2, ...] }`, replacing the
// full list) the same way OpenCTI patches other multi-value schema attributes.
// Task reassignment on an existing case template is comparatively rare; if the
// backend instead requires a dedicated relation mutation, this patch surfaces
// as a clear GraphQL error from `caseTemplateFieldPatch` rather than silently
// no-op.

/** The node fields we read back on every case template (list + mutation payloads). */
export const CASE_TEMPLATE_NODE_FIELDS = 'id name description tasks { edges { node { id name } } }'

// --- GraphQL documents --------------------------------------------------------

/** List every case template (paginated `edges { node }` connection). */
export const LIST_CASE_TEMPLATES_QUERY = `query CaseTemplates {
  caseTemplates {
    edges { node { ${CASE_TEMPLATE_NODE_FIELDS} } }
  }
}`

/** Create one case template. input: CaseTemplateAddInput! (`tasks` may be an empty array). */
export const ADD_CASE_TEMPLATE_MUTATION = `mutation CaseTemplateAdd($input: CaseTemplateAddInput!) {
  caseTemplateAdd(input: $input) { ${CASE_TEMPLATE_NODE_FIELDS} }
}`

/**
 * Patch fields on an existing case template. input: [EditInput!]!
 * `caseTemplateFieldPatch` also accepts optional `commitMessage`/`references`
 * args — intentionally omitted here.
 */
export const PATCH_CASE_TEMPLATE_MUTATION = `mutation CaseTemplateFieldPatch($id: ID!, $input: [EditInput!]!) {
  caseTemplateFieldPatch(id: $id, input: $input) { ${CASE_TEMPLATE_NODE_FIELDS} }
}`

/** Delete one case template by id — returns the deleted id. */
export const DELETE_CASE_TEMPLATE_MUTATION = `mutation CaseTemplateDelete($id: ID!) {
  caseTemplateDelete(id: $id)
}`

/**
 * A minimal, self-contained copy of the sibling case-task-templates type's list
 * query — used ONLY to resolve `task_template_names` into live ids. Config
 * types in this app do not cross-import each other's `_shared.ts`.
 */
export const LIST_TASK_TEMPLATES_FOR_RESOLUTION_QUERY = `query TaskTemplatesForResolution {
  taskTemplates {
    edges { node { id name } }
  }
}`

/** One task-template reference, as read back for name→id resolution. */
export interface OpenctiTaskTemplateRef {
  id?: string
  name?: string
}

/** One OpenCTI case template node. */
export interface OpenctiCaseTemplate {
  id?: string
  name?: string
  description?: string | null
  tasks?: { edges?: Array<{ node?: OpenctiTaskTemplateRef }> } | null
  [key: string]: unknown
}

/** The `input` for caseTemplateAdd. `tasks` is required but may be `[]`. */
export interface CaseTemplateAddInput {
  name: string
  description?: string
  tasks: string[]
}

/**
 * One EditInput entry for caseTemplateFieldPatch. `value` is `[Any]!` on the
 * OpenCTI backend — send native JS values, never stringify booleans/numbers. An
 * array-valued attribute like `tasks` is patched with `value` set to the FULL
 * replacement array of ids (not wrapped in another array).
 */
export interface EditInput {
  key: string
  value: unknown[]
}

/** Unwrap an OpenCTI `{ caseTemplates: { edges: [{ node }] } }` connection into a flat array. */
export function caseTemplatesFromList(data: unknown): OpenctiCaseTemplate[] {
  const edges = (data as { caseTemplates?: { edges?: Array<{ node?: OpenctiCaseTemplate }> } } | null | undefined)
    ?.caseTemplates?.edges
  if (!Array.isArray(edges)) return []
  return edges.map((e) => e?.node).filter((n): n is OpenctiCaseTemplate => !!n)
}

/** Find a live case template by its `name` (case-insensitive — the stable identity). */
export function findCaseTemplate(templates: OpenctiCaseTemplate[], name: string): OpenctiCaseTemplate | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return templates.find((t) => String(t.name ?? '').trim().toLowerCase() === n) ?? null
}

/** Unwrap an OpenCTI `{ taskTemplates: { edges: [{ node }] } }` connection into a flat array. */
export function taskTemplateRefsFromList(data: unknown): OpenctiTaskTemplateRef[] {
  const edges = (data as { taskTemplates?: { edges?: Array<{ node?: OpenctiTaskTemplateRef }> } } | null | undefined)
    ?.taskTemplates?.edges
  if (!Array.isArray(edges)) return []
  return edges.map((e) => e?.node).filter((n): n is OpenctiTaskTemplateRef => !!n)
}

/** Extract the live task-template ids currently attached to a case template. */
export function taskIdsOf(caseTemplate: OpenctiCaseTemplate): string[] {
  const edges = caseTemplate.tasks?.edges
  if (!Array.isArray(edges)) return []
  return edges.map((e) => e?.node?.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
}

/** Normalize a "tags" canvas field into a de-duplicated string list (array or comma-separated). */
export function toStringList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.map((v) => String(v ?? '').trim())
    : String(value ?? '').split(',').map((v) => v.trim())
  const out: string[] = []
  for (const v of raw) if (v && !out.includes(v)) out.push(v)
  return out
}

/**
 * Resolve a list of task-template NAMES into their live ids (case-insensitive).
 * A name with no live match is reported in `unresolved` rather than failing the
 * whole resolution — the caller decides how to surface that (deploy warns and
 * skips it; drift treats it as "not yet attached").
 */
export function resolveTaskTemplateIds(
  names: string[],
  liveTaskTemplates: OpenctiTaskTemplateRef[],
): { ids: string[]; unresolved: string[] } {
  const ids: string[] = []
  const unresolved: string[] = []
  for (const name of names) {
    const match = liveTaskTemplates.find((t) => String(t.name ?? '').trim().toLowerCase() === name.trim().toLowerCase())
    if (match?.id) ids.push(match.id)
    else unresolved.push(name)
  }
  return { ids, unresolved }
}

/** Trim a string field (undefined when blank). */
export function normalizeText(value: unknown): string | undefined {
  const s = String(value ?? '').trim()
  return s === '' ? undefined : s
}

/** Build the caseTemplateAdd input from canvas fields + already-resolved task ids. */
export function buildCaseTemplateInput(fields: Record<string, unknown>, taskIds: string[]): CaseTemplateAddInput {
  const input: CaseTemplateAddInput = { name: String(fields.name ?? '').trim(), tasks: taskIds }
  const description = normalizeText(fields.description)
  if (description !== undefined) input.description = description
  return input
}

/**
 * Build the caseTemplateFieldPatch `input` (an array of EditInput) from canvas
 * fields + already-resolved task ids. `name` is the identity and is not
 * rewritten. `tasks` is always patched to the full resolved list (see the
 * UNVERIFIED note above).
 */
export function buildCaseTemplatePatch(fields: Record<string, unknown>, taskIds: string[]): EditInput[] {
  const patch: EditInput[] = [{ key: 'tasks', value: taskIds }]
  const description = normalizeText(fields.description)
  if (description !== undefined) patch.push({ key: 'description', value: [description] })
  return patch
}

/** Build an EditInput[] that restores a prior case template body (for rollback). */
export function buildRestorePatch(prior: OpenctiCaseTemplate): EditInput[] {
  const patch: EditInput[] = [{ key: 'tasks', value: taskIdsOf(prior) }]
  if (prior.description != null) patch.push({ key: 'description', value: [String(prior.description)] })
  return patch
}
