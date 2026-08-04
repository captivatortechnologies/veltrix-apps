// Shared helpers for the OpenCTI Notification Triggers config type
// (deploy + rollback + drift). LIVE knowledge triggers only.
//
// The GraphQL operations below (triggerKnowledgeLiveAdd, triggerKnowledgeFieldPatch,
// triggerKnowledgeDelete) are verified against the OpenCTI GraphQL backend schema
// (opencti-platform/opencti, src/modules/notification/notification.graphql).
//
// Intentionally excluded (real, declarative, but out of scope for this pass):
//   - Digest triggers (`triggerKnowledgeDigestAdd`) — a digest cross-references
//     OTHER Trigger ids (`trigger_ids`), a bigger modeling task.
//   - Activity triggers (`triggerActivity*`) — a different, audit-log-scoped
//     surface gated by SETTINGS_SECURITYACTIVITY rather than plain knowledge
//     triggers.
//
// `notifiers` is `[StixRef!]` — internal ids of Notifiers (the sibling config
// type at config-types/notifiers/), NOT names. This type has no cross-import
// into that sibling directory (config types are self-contained); instead it
// runs its own minimal `notifiers` list query to resolve the canvas's
// `notifier_names` into live ids, the same read-then-match pattern used by the
// sibling case-templates → case-task-templates resolution.
//
// `recipients` is `[String!]` on BOTH the add input (raw ids) and, once
// resolved, `Trigger.recipients` reads back as `[Member!]` (objects) — not
// independently verified beyond "String" on the write side (platform member/
// user internal ids or emails); declared and diffed by id, not resolved by
// name.

/** `TriggerEventType` enum values this type authors (Live knowledge triggers). */
export const TRIGGER_EVENT_TYPES = new Set(['create', 'update', 'delete'])

/** The node fields we read back on every trigger (list + mutation payloads). */
export const TRIGGER_NODE_FIELDS =
  'id name description trigger_type event_types filters instance_trigger recipients { id } notifiers { id name }'

// --- GraphQL documents --------------------------------------------------------

/** List every trigger (paginated `edges { node }` connection) — Live and Digest alike. */
export const LIST_TRIGGERS_QUERY = `query Triggers {
  triggers {
    edges { node { ${TRIGGER_NODE_FIELDS} } }
  }
}`

/** Create one LIVE knowledge trigger. input: TriggerLiveAddInput! */
export const ADD_TRIGGER_MUTATION = `mutation TriggerKnowledgeLiveAdd($input: TriggerLiveAddInput!) {
  triggerKnowledgeLiveAdd(input: $input) { ${TRIGGER_NODE_FIELDS} }
}`

/** Patch fields on an existing trigger. input: [EditInput!]! */
export const PATCH_TRIGGER_MUTATION = `mutation TriggerKnowledgeFieldPatch($id: ID!, $input: [EditInput!]!) {
  triggerKnowledgeFieldPatch(id: $id, input: $input) { ${TRIGGER_NODE_FIELDS} }
}`

/** Delete one trigger by id — returns the deleted id. */
export const DELETE_TRIGGER_MUTATION = `mutation TriggerKnowledgeDelete($id: ID!) {
  triggerKnowledgeDelete(id: $id)
}`

/**
 * A minimal, self-contained copy of the sibling notifiers type's list query —
 * used ONLY to resolve `notifier_names` into live ids. Config types in this
 * app do not cross-import each other's `_shared.ts`.
 */
export const LIST_NOTIFIERS_FOR_RESOLUTION_QUERY = `query NotifiersForResolution {
  notifiers {
    edges { node { id name } }
  }
}`

/** One notifier reference, as read back for name→id resolution. */
export interface OpenctiNotifierRef {
  id?: string
  name?: string
}

/** One OpenCTI trigger node. */
export interface OpenctiTrigger {
  id?: string
  name?: string
  description?: string | null
  trigger_type?: string | null
  event_types?: string[] | null
  filters?: string | null
  instance_trigger?: boolean | null
  recipients?: Array<{ id?: string }> | null
  notifiers?: Array<{ id?: string; name?: string }> | null
  [key: string]: unknown
}

/** The `input` for triggerKnowledgeLiveAdd. */
export interface TriggerLiveAddInput {
  name: string
  description?: string
  event_types: string[]
  notifiers?: string[]
  instance_trigger: boolean
  filters?: string
  recipients?: string[]
}

/**
 * One EditInput entry for triggerKnowledgeFieldPatch. `value` is `[Any]!` on the
 * OpenCTI backend — send native JS values, never stringify booleans/numbers. An
 * array-valued attribute (`event_types`, `recipients`, `notifiers`) is patched
 * with `value` set to the FULL replacement array (not wrapped in another array).
 */
export interface EditInput {
  key: string
  value: unknown[]
}

/** Unwrap an OpenCTI `{ triggers: { edges: [{ node }] } }` connection into a flat array. */
export function triggersFromList(data: unknown): OpenctiTrigger[] {
  const edges = (data as { triggers?: { edges?: Array<{ node?: OpenctiTrigger }> } } | null | undefined)?.triggers?.edges
  if (!Array.isArray(edges)) return []
  return edges.map((e) => e?.node).filter((n): n is OpenctiTrigger => !!n)
}

/** Find a live trigger by its `name` (case-insensitive — the stable identity). */
export function findTrigger(triggers: OpenctiTrigger[], name: string): OpenctiTrigger | null {
  const n = name.trim().toLowerCase()
  if (!n) return null
  return triggers.find((t) => String(t.name ?? '').trim().toLowerCase() === n) ?? null
}

/** Unwrap an OpenCTI `{ notifiers: { edges: [{ node }] } }` connection into a flat array. */
export function notifierRefsFromList(data: unknown): OpenctiNotifierRef[] {
  const edges = (data as { notifiers?: { edges?: Array<{ node?: OpenctiNotifierRef }> } } | null | undefined)?.notifiers?.edges
  if (!Array.isArray(edges)) return []
  return edges.map((e) => e?.node).filter((n): n is OpenctiNotifierRef => !!n)
}

/** Extract the live notifier ids currently attached to a trigger. */
export function notifierIdsOf(trigger: OpenctiTrigger): string[] {
  if (!Array.isArray(trigger.notifiers)) return []
  return trigger.notifiers.map((n) => n?.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
}

/** Extract the live recipient ids currently attached to a trigger. */
export function recipientIdsOf(trigger: OpenctiTrigger): string[] {
  if (!Array.isArray(trigger.recipients)) return []
  return trigger.recipients.map((r) => r?.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
}

/** Normalize a "tags"/"multiselect" canvas field into a de-duplicated string list. */
export function toStringList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.map((v) => String(v ?? '').trim())
    : String(value ?? '').split(',').map((v) => v.trim())
  const out: string[] = []
  for (const v of raw) if (v && !out.includes(v)) out.push(v)
  return out
}

/**
 * Resolve a list of notifier NAMES into their live ids (case-insensitive). A
 * name with no live match is reported in `unresolved` rather than failing the
 * whole resolution — deploy warns and skips it; drift excludes it from the
 * "expected" set.
 */
export function resolveNotifierIds(names: string[], liveNotifiers: OpenctiNotifierRef[]): { ids: string[]; unresolved: string[] } {
  const ids: string[] = []
  const unresolved: string[] = []
  for (const name of names) {
    const match = liveNotifiers.find((n) => String(n.name ?? '').trim().toLowerCase() === name.trim().toLowerCase())
    if (match?.id) ids.push(match.id)
    else unresolved.push(name)
  }
  return { ids, unresolved }
}

/** Coerce a canvas checkbox field to a boolean (defaulting to false when blank). */
export function normalizeBool(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  const s = String(value).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes') return true
  if (s === 'false' || s === '0' || s === 'no') return false
  return fallback
}

/** Trim a string field (undefined when blank). */
export function normalizeText(value: unknown): string | undefined {
  const s = String(value ?? '').trim()
  return s === '' ? undefined : s
}

/** Build the triggerKnowledgeLiveAdd input from canvas fields + already-resolved notifier ids. */
export function buildTriggerInput(fields: Record<string, unknown>, notifierIds: string[]): TriggerLiveAddInput {
  const input: TriggerLiveAddInput = {
    name: String(fields.name ?? '').trim(),
    event_types: toStringList(fields.event_types),
    instance_trigger: normalizeBool(fields.instance_trigger, false),
  }
  const description = normalizeText(fields.description)
  if (description !== undefined) input.description = description
  const filters = normalizeText(fields.filters)
  if (filters !== undefined) input.filters = filters
  const recipients = toStringList(fields.recipients)
  if (recipients.length > 0) input.recipients = recipients
  if (notifierIds.length > 0) input.notifiers = notifierIds
  return input
}

/**
 * Build the triggerKnowledgeFieldPatch `input` (an array of EditInput) from
 * canvas fields + already-resolved notifier ids. `name` is the identity and is
 * not rewritten.
 */
export function buildTriggerPatch(fields: Record<string, unknown>, notifierIds: string[]): EditInput[] {
  const patch: EditInput[] = [
    { key: 'event_types', value: toStringList(fields.event_types) },
    { key: 'instance_trigger', value: [normalizeBool(fields.instance_trigger, false)] },
    { key: 'recipients', value: toStringList(fields.recipients) },
    { key: 'notifiers', value: notifierIds },
  ]
  const description = normalizeText(fields.description)
  if (description !== undefined) patch.push({ key: 'description', value: [description] })
  const filters = normalizeText(fields.filters)
  if (filters !== undefined) patch.push({ key: 'filters', value: [filters] })
  return patch
}

/** Build an EditInput[] that restores a prior trigger body (for rollback). */
export function buildRestorePatch(prior: OpenctiTrigger): EditInput[] {
  const patch: EditInput[] = [
    { key: 'event_types', value: Array.isArray(prior.event_types) ? prior.event_types : [] },
    { key: 'instance_trigger', value: [prior.instance_trigger ?? false] },
    { key: 'recipients', value: recipientIdsOf(prior) },
    { key: 'notifiers', value: notifierIdsOf(prior) },
  ]
  if (prior.description != null) patch.push({ key: 'description', value: [String(prior.description)] })
  if (prior.filters != null) patch.push({ key: 'filters', value: [String(prior.filters)] })
  return patch
}
