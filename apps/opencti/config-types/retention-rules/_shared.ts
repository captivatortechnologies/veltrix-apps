// Shared helpers for the OpenCTI Retention Rules config type
// (deploy + rollback + drift).
//
// The GraphQL operations below (retentionRuleAdd, retentionRuleEdit.fieldPatch,
// retentionRuleEdit.delete) are verified against the OpenCTI GraphQL backend
// schema (opencti-platform/opencti, src/modules/retentionRules/retentionRules.graphql).
// OpenCTI exposes retention rule edits through a nested editor mutation —
// `retentionRuleEdit(id) { fieldPatch(input) / delete }` — same shape as
// Group/Role/MarkingDefinition, not a top-level `retentionRuleFieldPatch`.

/** The node fields we read back on every retention rule (list + mutation payloads). */
export const RETENTION_RULE_NODE_FIELDS = 'id name filters max_retention retention_unit scope active'

// --- GraphQL documents --------------------------------------------------------

/** List every retention rule (paginated `edges { node }` connection). */
export const LIST_RETENTION_RULES_QUERY = `query RetentionRules {
  retentionRules {
    edges { node { ${RETENTION_RULE_NODE_FIELDS} } }
  }
}`

/** Create one retention rule. input: RetentionRuleAddInput! */
export const ADD_RETENTION_RULE_MUTATION = `mutation RetentionRuleAdd($input: RetentionRuleAddInput!) {
  retentionRuleAdd(input: $input) { ${RETENTION_RULE_NODE_FIELDS} }
}`

/** Patch fields on an existing retention rule via the nested editor mutation. input: [EditInput!]! */
export const PATCH_RETENTION_RULE_MUTATION = `mutation RetentionRuleEdit($id: ID!, $input: [EditInput!]!) {
  retentionRuleEdit(id: $id) {
    fieldPatch(input: $input) { ${RETENTION_RULE_NODE_FIELDS} }
  }
}`

/** Delete one retention rule via the nested editor mutation — returns the deleted id. */
export const DELETE_RETENTION_RULE_MUTATION = `mutation RetentionRuleDelete($id: ID!) {
  retentionRuleEdit(id: $id) {
    delete
  }
}`

/** One OpenCTI retention rule node. */
export interface OpenctiRetentionRule {
  id?: string
  name?: string
  filters?: string | null
  max_retention?: number | null
  retention_unit?: string | null
  scope?: string | null
  active?: boolean | null
  [key: string]: unknown
}

/** The `input` for retentionRuleAdd. */
export interface RetentionRuleAddInput {
  name: string
  scope: string
  max_retention: number
  filters?: string
  retention_unit?: string
  active?: boolean
}

/**
 * One EditInput entry for retentionRuleEdit.fieldPatch. `value` is `[Any]!` on
 * the OpenCTI backend — send native JS values, never stringify booleans/numbers.
 */
export interface EditInput {
  key: string
  value: unknown[]
}

/** Unwrap an OpenCTI `{ retentionRules: { edges: [{ node }] } }` connection into a flat array. */
export function retentionRulesFromList(data: unknown): OpenctiRetentionRule[] {
  const edges = (data as { retentionRules?: { edges?: Array<{ node?: OpenctiRetentionRule }> } } | null | undefined)
    ?.retentionRules?.edges
  if (!Array.isArray(edges)) return []
  return edges.map((e) => e?.node).filter((n): n is OpenctiRetentionRule => !!n)
}

/** Find a live retention rule by its `name` (case-insensitive — the stable identity). */
export function findRetentionRule(rules: OpenctiRetentionRule[], name: string): OpenctiRetentionRule | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return rules.find((r) => String(r.name ?? '').trim().toLowerCase() === n) ?? null
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

/** Coerce a canvas number field to a finite number (undefined when blank/invalid). */
export function normalizeNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** Build the retentionRuleAdd input from canvas fields. */
export function buildRetentionRuleInput(fields: Record<string, unknown>): RetentionRuleAddInput {
  const input: RetentionRuleAddInput = {
    name: String(fields.name ?? '').trim(),
    scope: String(fields.scope ?? '').trim(),
    max_retention: normalizeNumber(fields.max_retention) ?? 1,
  }
  const filters = normalizeText(fields.filters)
  if (filters !== undefined) input.filters = filters
  const retentionUnit = normalizeText(fields.retention_unit)
  if (retentionUnit !== undefined) input.retention_unit = retentionUnit
  const active = normalizeBool(fields.active)
  if (active !== undefined) input.active = active
  return input
}

/**
 * Build the retentionRuleEdit.fieldPatch `input` (an array of EditInput) from
 * canvas fields. Only mutable fields are patched — `name` is the identity and
 * is not rewritten.
 */
export function buildRetentionRulePatch(fields: Record<string, unknown>): EditInput[] {
  const patch: EditInput[] = []
  const scope = normalizeText(fields.scope)
  if (scope !== undefined) patch.push({ key: 'scope', value: [scope] })
  const maxRetention = normalizeNumber(fields.max_retention)
  if (maxRetention !== undefined) patch.push({ key: 'max_retention', value: [maxRetention] })
  const retentionUnit = normalizeText(fields.retention_unit)
  if (retentionUnit !== undefined) patch.push({ key: 'retention_unit', value: [retentionUnit] })
  const filters = normalizeText(fields.filters)
  if (filters !== undefined) patch.push({ key: 'filters', value: [filters] })
  const active = normalizeBool(fields.active)
  if (active !== undefined) patch.push({ key: 'active', value: [active] })
  return patch
}

/** Build an EditInput[] that restores a prior retention rule body (for rollback). */
export function buildRestorePatch(prior: OpenctiRetentionRule): EditInput[] {
  const patch: EditInput[] = []
  if (prior.scope != null) patch.push({ key: 'scope', value: [prior.scope] })
  if (prior.max_retention != null) patch.push({ key: 'max_retention', value: [prior.max_retention] })
  if (prior.retention_unit != null) patch.push({ key: 'retention_unit', value: [prior.retention_unit] })
  if (prior.filters != null) patch.push({ key: 'filters', value: [prior.filters] })
  if (prior.active != null) patch.push({ key: 'active', value: [prior.active] })
  return patch
}
