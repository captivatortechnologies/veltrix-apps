// Shared helpers for the OpenCTI Case Task Templates config type
// (deploy + rollback + drift).
//
// The GraphQL operations below (taskTemplateAdd, taskTemplateFieldPatch,
// taskTemplateDelete) are verified against the OpenCTI GraphQL backend schema
// (opencti-platform/opencti, src/modules/task/task-template/task-template.graphql).
//
// Referenced by the sibling case-templates config type (`caseTemplateAdd`'s
// `tasks: [StixRef!]` field) — that type looks up a task template's live id by
// matching this type's `name`.

/** The node fields we read back on every task template (list + mutation payloads). */
export const TASK_TEMPLATE_NODE_FIELDS = 'id name description'

// --- GraphQL documents --------------------------------------------------------

/** List every case task template (paginated `edges { node }` connection). */
export const LIST_TASK_TEMPLATES_QUERY = `query TaskTemplates {
  taskTemplates {
    edges { node { ${TASK_TEMPLATE_NODE_FIELDS} } }
  }
}`

/** Create one task template. input: TaskTemplateAddInput! */
export const ADD_TASK_TEMPLATE_MUTATION = `mutation TaskTemplateAdd($input: TaskTemplateAddInput!) {
  taskTemplateAdd(input: $input) { ${TASK_TEMPLATE_NODE_FIELDS} }
}`

/**
 * Patch fields on an existing task template. input: [EditInput!]!
 * `taskTemplateFieldPatch` also accepts optional `commitMessage`/`references`
 * args — intentionally omitted here.
 */
export const PATCH_TASK_TEMPLATE_MUTATION = `mutation TaskTemplateFieldPatch($id: ID!, $input: [EditInput!]!) {
  taskTemplateFieldPatch(id: $id, input: $input) { ${TASK_TEMPLATE_NODE_FIELDS} }
}`

/** Delete one task template by id — returns the deleted id. */
export const DELETE_TASK_TEMPLATE_MUTATION = `mutation TaskTemplateDelete($id: ID!) {
  taskTemplateDelete(id: $id)
}`

/** One OpenCTI case task template node. */
export interface OpenctiTaskTemplate {
  id?: string
  name?: string
  description?: string | null
  [key: string]: unknown
}

/** The `input` for taskTemplateAdd. */
export interface TaskTemplateAddInput {
  name: string
  description?: string
}

/**
 * One EditInput entry for taskTemplateFieldPatch. `value` is `[Any]!` on the
 * OpenCTI backend — send native JS values, never stringify booleans/numbers.
 */
export interface EditInput {
  key: string
  value: unknown[]
}

/** Unwrap an OpenCTI `{ taskTemplates: { edges: [{ node }] } }` connection into a flat array. */
export function taskTemplatesFromList(data: unknown): OpenctiTaskTemplate[] {
  const edges = (data as { taskTemplates?: { edges?: Array<{ node?: OpenctiTaskTemplate }> } } | null | undefined)
    ?.taskTemplates?.edges
  if (!Array.isArray(edges)) return []
  return edges.map((e) => e?.node).filter((n): n is OpenctiTaskTemplate => !!n)
}

/** Find a live task template by its `name` (case-insensitive — the stable identity). */
export function findTaskTemplate(templates: OpenctiTaskTemplate[], name: string): OpenctiTaskTemplate | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return templates.find((t) => String(t.name ?? '').trim().toLowerCase() === n) ?? null
}

/** Trim a string field (undefined when blank). */
export function normalizeText(value: unknown): string | undefined {
  const s = String(value ?? '').trim()
  return s === '' ? undefined : s
}

/** Build the taskTemplateAdd input from canvas fields. */
export function buildTaskTemplateInput(fields: Record<string, unknown>): TaskTemplateAddInput {
  const input: TaskTemplateAddInput = { name: String(fields.name ?? '').trim() }
  const description = normalizeText(fields.description)
  if (description !== undefined) input.description = description
  return input
}

/**
 * Build the taskTemplateFieldPatch `input` (an array of EditInput) from canvas
 * fields. Only the mutable presentation field is patched — `name` is the
 * identity and is not rewritten.
 */
export function buildTaskTemplatePatch(fields: Record<string, unknown>): EditInput[] {
  const patch: EditInput[] = []
  const description = normalizeText(fields.description)
  if (description !== undefined) patch.push({ key: 'description', value: [description] })
  return patch
}

/** Build an EditInput[] that restores a prior task template body (for rollback). */
export function buildRestorePatch(prior: OpenctiTaskTemplate): EditInput[] {
  const patch: EditInput[] = []
  if (prior.description != null) patch.push({ key: 'description', value: [String(prior.description)] })
  return patch
}
