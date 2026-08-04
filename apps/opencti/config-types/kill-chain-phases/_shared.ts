// Shared helpers for the OpenCTI Kill Chain Phases config type (deploy + rollback + drift).
//
// The GraphQL operations below were verified against the OpenCTI GraphQL backend
// schema (opencti-platform/opencti, config/schema/opencti.graphql, type
// `KillChainPhase`). OpenCTI exposes kill-chain-phase edits through the nested
// editor mutation — `killChainPhaseEdit(id) { fieldPatch(input) / delete }` — the
// same nested shape as MarkingDefinition and Group, not a top-level
// `killChainPhaseFieldPatch`/`killChainPhaseDelete`.

/** The node fields we read back on every kill-chain phase (list + mutation payloads). */
export const KILL_CHAIN_PHASE_NODE_FIELDS = 'id kill_chain_name phase_name x_opencti_order'

// --- GraphQL documents --------------------------------------------------------

/** List every kill-chain phase (paginated `edges { node }` connection). */
export const LIST_KILL_CHAIN_PHASES_QUERY = `query KillChainPhases {
  killChainPhases {
    edges { node { ${KILL_CHAIN_PHASE_NODE_FIELDS} } }
  }
}`

/** Create one kill-chain phase. input: KillChainPhaseAddInput! */
export const ADD_KILL_CHAIN_PHASE_MUTATION = `mutation KillChainPhaseAdd($input: KillChainPhaseAddInput!) {
  killChainPhaseAdd(input: $input) { ${KILL_CHAIN_PHASE_NODE_FIELDS} }
}`

/** Patch fields on an existing kill-chain phase via the nested editor mutation. input: [EditInput]! */
export const PATCH_KILL_CHAIN_PHASE_MUTATION = `mutation KillChainPhaseEdit($id: ID!, $input: [EditInput]!) {
  killChainPhaseEdit(id: $id) {
    fieldPatch(input: $input) { ${KILL_CHAIN_PHASE_NODE_FIELDS} }
  }
}`

/** Delete one kill-chain phase by id, via the nested editor mutation — returns the deleted id. */
export const DELETE_KILL_CHAIN_PHASE_MUTATION = `mutation KillChainPhaseDelete($id: ID!) {
  killChainPhaseEdit(id: $id) {
    delete
  }
}`

/** One OpenCTI kill-chain phase node. */
export interface OpenctiKillChainPhase {
  id?: string
  kill_chain_name?: string
  phase_name?: string
  x_opencti_order?: number | null
  [key: string]: unknown
}

/** The `input` for killChainPhaseAdd. `x_opencti_order` is `Int!` — always sent, defaulting to 0. */
export interface KillChainPhaseAddInput {
  kill_chain_name: string
  phase_name: string
  x_opencti_order: number
}

/** One EditInput entry for killChainPhaseEdit.fieldPatch. `value` is `[Any]!` — native JSON values, never stringified. */
export interface EditInput {
  key: string
  value: unknown[]
}

/** Unwrap an OpenCTI `{ killChainPhases: { edges: [{ node }] } }` connection into a flat array. */
export function killChainPhasesFromList(data: unknown): OpenctiKillChainPhase[] {
  const edges = (data as { killChainPhases?: { edges?: Array<{ node?: OpenctiKillChainPhase }> } } | null | undefined)
    ?.killChainPhases?.edges
  if (!Array.isArray(edges)) return []
  return edges.map((e) => e?.node).filter((n): n is OpenctiKillChainPhase => !!n)
}

/**
 * Find a live kill-chain phase by its compound identity: `kill_chain_name` +
 * `phase_name` together (case-insensitive). Two different kill chains can reuse
 * the same phase name (e.g. "reconnaissance"), so matching on `phase_name` alone
 * would collide across chains.
 */
export function findKillChainPhase(
  phases: OpenctiKillChainPhase[],
  killChainName: string,
  phaseName: string,
): OpenctiKillChainPhase | null {
  const chain = killChainName.trim().toLowerCase()
  const phase = phaseName.trim().toLowerCase()
  if (!chain || !phase) return null
  return (
    phases.find(
      (p) => String(p.kill_chain_name ?? '').trim().toLowerCase() === chain && String(p.phase_name ?? '').trim().toLowerCase() === phase,
    ) ?? null
  )
}

/** Coerce a canvas order field to a non-negative integer, defaulting to 0 (never undefined — the create input requires it). */
export function normalizeOrder(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

/** Build the killChainPhaseAdd input from canvas fields. */
export function buildKillChainPhaseInput(fields: Record<string, unknown>): KillChainPhaseAddInput {
  return {
    kill_chain_name: String(fields.kill_chain_name ?? '').trim(),
    phase_name: String(fields.phase_name ?? '').trim(),
    x_opencti_order: normalizeOrder(fields.x_opencti_order),
  }
}

/**
 * Build the killChainPhaseEdit.fieldPatch `input` (an array of EditInput) from
 * canvas fields. Only the mutable `x_opencti_order` is patched — `kill_chain_name`
 * and `phase_name` together are the identity and are not rewritten.
 */
export function buildKillChainPhasePatch(fields: Record<string, unknown>): EditInput[] {
  return [{ key: 'x_opencti_order', value: [normalizeOrder(fields.x_opencti_order)] }]
}

/** Build an EditInput[] that restores a prior kill-chain-phase body (for rollback). */
export function buildRestorePatch(prior: OpenctiKillChainPhase): EditInput[] {
  const patch: EditInput[] = []
  if (prior.x_opencti_order != null) patch.push({ key: 'x_opencti_order', value: [normalizeOrder(prior.x_opencti_order)] })
  return patch
}
