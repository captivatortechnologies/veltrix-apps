// Shared helpers for the OpenCTI Vocabularies config type (deploy + rollback + drift).
//
// The GraphQL operations below were verified against the OpenCTI GraphQL backend
// schema (opencti-platform/opencti, src/modules/vocabulary/vocabulary.graphql).
// Vocabulary uses the flat top-level mutation shape — `vocabularyAdd(input)`,
// `vocabularyFieldPatch(id, input)`, `vocabularyDelete(id)` — the same flat shape
// as Label, not a nested `vocabularyEdit(id) { fieldPatch }`.

/**
 * The exact `VocabularyCategory` enum, verified against
 * src/modules/vocabulary/vocabulary.graphql. Used by the canvas `category`
 * select field and validate.ts's enum-membership check.
 */
export const VOCABULARY_CATEGORIES = new Set([
  'account_type_ov',
  'attack_motivation_ov',
  'attack_resource_level_ov',
  'case_severity_ov',
  'case_priority_ov',
  'channel_types_ov',
  'collection_layers_ov',
  'event_type_ov',
  'grouping_context_ov',
  'implementation_language_ov',
  'incident_response_types_ov',
  'incident_type_ov',
  'incident_severity_ov',
  'indicator_type_ov',
  'infrastructure_type_ov',
  'integrity_level_ov',
  'malware_capabilities_ov',
  'malware_result_ov',
  'malware_type_ov',
  'platforms_ov',
  'opinion_ov',
  'organization_type_ov',
  'pattern_type_ov',
  'permissions_ov',
  'processor_architecture_ov',
  'reliability_ov',
  'report_types_ov',
  'request_for_information_types_ov',
  'request_for_takedown_types_ov',
  'security_platform_type_ov',
  'service_status_ov',
  'service_type_ov',
  'start_type_ov',
  'key_type_ov',
  'threat_actor_group_type_ov',
  'threat_actor_group_role_ov',
  'threat_actor_group_sophistication_ov',
  'threat_actor_individual_type_ov',
  'threat_actor_individual_role_ov',
  'threat_actor_individual_sophistication_ov',
  'tool_types_ov',
  'note_types_ov',
  'gender_ov',
  'marital_status_ov',
  'hair_color_ov',
  'eye_color_ov',
  'persona_type_ov',
  'coverage_ov',
])

/**
 * The node fields we read back on every vocabulary entry (list + mutation
 * payloads). `category` is an OBJECT on the node (`VocabularyDefinition!`), so
 * only its `key` is selected — NOT the bare scalar sent on create.
 */
export const VOCABULARY_NODE_FIELDS = 'id name description category { key } order aliases builtIn'

// --- GraphQL documents --------------------------------------------------------

/** List every vocabulary entry (paginated `edges { node }` connection). */
export const LIST_VOCABULARIES_QUERY = `query Vocabularies {
  vocabularies {
    edges { node { ${VOCABULARY_NODE_FIELDS} } }
  }
}`

/** Create one vocabulary entry. input: VocabularyAddInput! */
export const ADD_VOCABULARY_MUTATION = `mutation VocabularyAdd($input: VocabularyAddInput!) {
  vocabularyAdd(input: $input) { ${VOCABULARY_NODE_FIELDS} }
}`

/** Patch fields on an existing vocabulary entry. input: [EditInput!]! */
export const PATCH_VOCABULARY_MUTATION = `mutation VocabularyFieldPatch($id: ID!, $input: [EditInput!]!) {
  vocabularyFieldPatch(id: $id, input: $input) { ${VOCABULARY_NODE_FIELDS} }
}`

/** Delete one vocabulary entry by id — returns the deleted id. */
export const DELETE_VOCABULARY_MUTATION = `mutation VocabularyDelete($id: ID!) {
  vocabularyDelete(id: $id)
}`

/** One OpenCTI vocabulary node. `category` is the node's object shape (`{ key }`), not the bare enum. */
export interface OpenctiVocabulary {
  id?: string
  name?: string
  description?: string | null
  category?: { key?: string | null } | null
  order?: number | null
  aliases?: string[] | null
  builtIn?: boolean | null
  [key: string]: unknown
}

/** The `input` for vocabularyAdd. `category` here IS the bare `VocabularyCategory` enum scalar. */
export interface VocabularyAddInput {
  name: string
  description?: string
  category: string
  order?: number
  aliases?: string[]
}

/** One EditInput entry for vocabularyFieldPatch. `value` is `[Any]!` — native JSON values, never stringified. */
export interface EditInput {
  key: string
  value: unknown[]
}

/** Unwrap an OpenCTI `{ vocabularies: { edges: [{ node }] } }` connection into a flat array. */
export function vocabulariesFromList(data: unknown): OpenctiVocabulary[] {
  const edges = (data as { vocabularies?: { edges?: Array<{ node?: OpenctiVocabulary }> } } | null | undefined)?.vocabularies?.edges
  if (!Array.isArray(edges)) return []
  return edges.map((e) => e?.node).filter((n): n is OpenctiVocabulary => !!n)
}

/** Extract the plain category key string from a live vocabulary node's `category { key }` object. */
export function categoryKeyOf(vocab: OpenctiVocabulary): string {
  return String(vocab.category?.key ?? '').trim().toLowerCase()
}

/**
 * Find a live vocabulary entry by its compound identity: `category` + `name`
 * together (case-insensitive). A name is only unique within its category (e.g.
 * "high" can exist in both `reliability_ov` and `integrity_level_ov`), so
 * matching on `name` alone would collide across categories.
 */
export function findVocabulary(vocabularies: OpenctiVocabulary[], category: string, name: string): OpenctiVocabulary | null {
  const cat = category.trim().toLowerCase()
  const n = name.trim().toLowerCase()
  if (!cat || !n) return null
  return vocabularies.find((v) => categoryKeyOf(v) === cat && String(v.name ?? '').trim().toLowerCase() === n) ?? null
}

/** Coerce a canvas order field to a non-negative integer (undefined when blank). */
export function normalizeOrder(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : undefined
}

/** Trim a description (undefined when blank). */
export function normalizeText(value: unknown): string | undefined {
  const s = String(value ?? '').trim()
  return s === '' ? undefined : s
}

/** Split a canvas `aliases` tags value into a trimmed, de-duplicated list of non-empty strings. */
export function toStringList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.map((v) => String(v ?? '').trim())
    : String(value ?? '').trim().split(',').map((v) => v.trim())
  const out: string[] = []
  for (const v of raw) if (v && !out.includes(v)) out.push(v)
  return out
}

/** Build the vocabularyAdd input from canvas fields. */
export function buildVocabularyInput(fields: Record<string, unknown>): VocabularyAddInput {
  const input: VocabularyAddInput = {
    name: String(fields.name ?? '').trim(),
    category: String(fields.category ?? '').trim(),
  }
  const description = normalizeText(fields.description)
  if (description !== undefined) input.description = description
  const order = normalizeOrder(fields.order)
  if (order !== undefined) input.order = order
  const aliases = toStringList(fields.aliases)
  if (aliases.length > 0) input.aliases = aliases
  return input
}

/**
 * Build the vocabularyFieldPatch `input` (an array of EditInput) from canvas
 * fields. Only mutable fields are patched — `category` + `name` together are
 * the identity and are not rewritten.
 */
export function buildVocabularyPatch(fields: Record<string, unknown>): EditInput[] {
  const patch: EditInput[] = []
  const description = normalizeText(fields.description)
  if (description !== undefined) patch.push({ key: 'description', value: [description] })
  const order = normalizeOrder(fields.order)
  if (order !== undefined) patch.push({ key: 'order', value: [order] })
  const aliases = toStringList(fields.aliases)
  if (aliases.length > 0) patch.push({ key: 'aliases', value: aliases })
  return patch
}

/** Build an EditInput[] that restores a prior vocabulary body (for rollback). */
export function buildRestorePatch(prior: OpenctiVocabulary): EditInput[] {
  const patch: EditInput[] = []
  if (prior.description != null) patch.push({ key: 'description', value: [String(prior.description)] })
  if (prior.order != null) patch.push({ key: 'order', value: [Number(prior.order)] })
  if (prior.aliases != null) patch.push({ key: 'aliases', value: Array.isArray(prior.aliases) ? prior.aliases : [] })
  return patch
}
