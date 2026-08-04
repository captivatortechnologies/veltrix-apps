// Shared helpers for the OpenCTI Status Templates config type (deploy + rollback +
// drift).
//
// Operations verified against the OpenCTI GraphQL backend schema
// (opencti-platform/opencti, config/schema/opencti.graphql), type `StatusTemplate`.
// OpenCTI exposes status-template mutations flat at the top level —
// `statusTemplateAdd`/`statusTemplateFieldPatch`/`statusTemplateDelete` — same
// shape as Label, not a nested editor. Unlike Label, `color` is REQUIRED on
// create (`StatusTemplateAddInput { name: String!, color: String! }`).
//
// SCOPE: this manages the reusable Status Template color/name library only.
// Assigning a template to a specific entity subtype's ordered kanban workflow —
// `subTypeEdit(id) { statusAdd(input:{template_id,order,scope}) /
// statusFieldPatch / statusDelete }` — is a separate, materially bigger
// cross-referencing/ordering surface (parent = subtype id/type name, ordered
// children reference template_id) intentionally excluded from this pass; a good
// candidate for its own dedicated follow-up type.

/** The node fields we read back on every status template (list + mutation payloads). */
export const STATUS_TEMPLATE_NODE_FIELDS = 'id name color'

// --- GraphQL documents --------------------------------------------------------

/** List every status template (paginated `edges { node }` connection). NOTE: `statusTemplates` takes no `filters` arg. */
export const LIST_STATUS_TEMPLATES_QUERY = `query StatusTemplates {
  statusTemplates {
    edges { node { ${STATUS_TEMPLATE_NODE_FIELDS} } }
  }
}`

/** Create one status template. input: StatusTemplateAddInput! */
export const ADD_STATUS_TEMPLATE_MUTATION = `mutation StatusTemplateAdd($input: StatusTemplateAddInput!) {
  statusTemplateAdd(input: $input) { ${STATUS_TEMPLATE_NODE_FIELDS} }
}`

/** Patch fields on an existing status template. input: [EditInput!]! */
export const PATCH_STATUS_TEMPLATE_MUTATION = `mutation StatusTemplateFieldPatch($id: ID!, $input: [EditInput!]!) {
  statusTemplateFieldPatch(id: $id, input: $input) { ${STATUS_TEMPLATE_NODE_FIELDS} }
}`

/** Delete one status template by id — returns the deleted id. */
export const DELETE_STATUS_TEMPLATE_MUTATION = `mutation StatusTemplateDelete($id: ID!) {
  statusTemplateDelete(id: $id)
}`

/** One OpenCTI status template node. */
export interface OpenctiStatusTemplate {
  id?: string
  name?: string
  color?: string | null
  [key: string]: unknown
}

/** The `input` for statusTemplateAdd. Both fields are required. */
export interface StatusTemplateAddInput {
  name: string
  color: string
}

/** One EditInput entry for statusTemplateFieldPatch. `value` is `[Any]!` — send native JS values, never stringify. */
export interface EditInput {
  key: string
  value: unknown[]
}

/** Unwrap an OpenCTI `{ statusTemplates: { edges: [{ node }] } }` connection into a flat array. */
export function statusTemplatesFromList(data: unknown): OpenctiStatusTemplate[] {
  const edges = (data as { statusTemplates?: { edges?: Array<{ node?: OpenctiStatusTemplate }> } } | null | undefined)
    ?.statusTemplates?.edges
  if (!Array.isArray(edges)) return []
  return edges.map((e) => e?.node).filter((n): n is OpenctiStatusTemplate => !!n)
}

/** Find a live status template by its `name` (case-insensitive — the stable identity). */
export function findStatusTemplate(templates: OpenctiStatusTemplate[], name: string): OpenctiStatusTemplate | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return templates.find((t) => String(t.name ?? '').trim().toLowerCase() === n) ?? null
}

/** Trim a hex color (undefined when blank). */
export function normalizeColor(value: unknown): string | undefined {
  const s = String(value ?? '').trim()
  return s === '' ? undefined : s
}

/** Build the statusTemplateAdd input from canvas fields. Both fields are required. */
export function buildStatusTemplateInput(fields: Record<string, unknown>): StatusTemplateAddInput {
  return {
    name: String(fields.name ?? '').trim(),
    color: String(fields.color ?? '').trim(),
  }
}

/**
 * Build the statusTemplateFieldPatch `input` (an array of EditInput) from canvas
 * fields. Only the mutable presentation field is patched — `name` is the identity
 * and is not rewritten.
 */
export function buildStatusTemplatePatch(fields: Record<string, unknown>): EditInput[] {
  const patch: EditInput[] = []
  const color = normalizeColor(fields.color)
  if (color !== undefined) patch.push({ key: 'color', value: [color] })
  return patch
}

/** Build an EditInput[] that restores a prior status template body (for rollback). */
export function buildRestorePatch(prior: OpenctiStatusTemplate): EditInput[] {
  const patch: EditInput[] = []
  if (prior.color != null) patch.push({ key: 'color', value: [String(prior.color)] })
  return patch
}
