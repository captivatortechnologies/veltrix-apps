// Shared helpers for the Repository Rulesets config type
// (deploy + rollback + drift + validate).
//
// A canvas item declares ONE ruleset — branch / tag / push protection — for a
// repository (owner/repo) OR an organization (owner only, repo blank), identified
// by name within that scope. These helpers translate the canvas fields to the
// GitHub REST shapes on:
//   /repos/{owner}/{repo}/rulesets   and   /orgs/{org}/rulesets
// (create POST, update PUT, delete DELETE). Docs (verified against
// docs.github.com/rest):
//   https://docs.github.com/en/rest/repos/rules
//   https://docs.github.com/en/rest/orgs/rules

export const RULESET_TARGETS = ['branch', 'tag', 'push'] as const
export const RULESET_ENFORCEMENTS = ['active', 'evaluate', 'disabled'] as const

/** The desired state one canvas item declares (raw JSON kept as text for validate to parse). */
export interface RulesetDesired {
  owner: string
  repository: string
  name: string
  target: string
  enforcement: string
  rulesRaw: string
  conditionsRaw: string
  bypassActorsRaw: string
}

/** A ruleset as returned by GitHub — the slice this app reads. */
export interface LiveRuleset {
  id?: number
  name?: string
  target?: string
  enforcement?: string
  rules?: unknown[]
  conditions?: Record<string, unknown> | null
  bypass_actors?: unknown[]
  [key: string]: unknown
}

const asText = (v: unknown): string => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v))

/** Read one canvas item's fields into the desired-state record. */
export function desiredFromItem(fields: Record<string, unknown>): RulesetDesired {
  return {
    owner: asText(fields.owner),
    repository: asText(fields.repository),
    name: asText(fields.name),
    target: (asText(fields.target) || 'branch').toLowerCase(),
    enforcement: (asText(fields.enforcement) || 'active').toLowerCase(),
    rulesRaw: typeof fields.rules === 'string' ? fields.rules : jsonOrEmpty(fields.rules),
    conditionsRaw: typeof fields.conditions === 'string' ? fields.conditions : jsonOrEmpty(fields.conditions),
    bypassActorsRaw: typeof fields.bypass_actors === 'string' ? fields.bypass_actors : jsonOrEmpty(fields.bypass_actors),
  }
}

/** A pre-serialised object/array field → its JSON text (so parse paths are uniform). */
function jsonOrEmpty(v: unknown): string {
  if (v == null) return ''
  try {
    return JSON.stringify(v)
  } catch {
    return ''
  }
}

/** Parse a JSON array from text. Blank → an empty array (no error). */
export function parseJsonArray(raw: string): { value: unknown[]; error?: string } {
  const t = raw.trim()
  if (!t) return { value: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(t)
  } catch (e) {
    return { value: [], error: e instanceof Error ? e.message : 'invalid JSON' }
  }
  if (!Array.isArray(parsed)) return { value: [], error: 'must be a JSON array' }
  return { value: parsed }
}

/** Parse a JSON object from text. Blank → null (omit the field). */
export function parseJsonObject(raw: string): { value: Record<string, unknown> | null; error?: string } {
  const t = raw.trim()
  if (!t) return { value: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(t)
  } catch (e) {
    return { value: null, error: e instanceof Error ? e.message : 'invalid JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { value: null, error: 'must be a JSON object' }
  }
  return { value: parsed as Record<string, unknown> }
}

/**
 * Build the ruleset request body (create/update take the same shape). Returns the
 * body plus any JSON-parse errors so callers can fail an item cleanly. Empty
 * conditions / bypass_actors are omitted.
 */
export function buildRulesetBody(desired: RulesetDesired): { body: Record<string, unknown>; errors: string[] } {
  const errors: string[] = []

  const rules = parseJsonArray(desired.rulesRaw)
  if (rules.error) errors.push(`rules: ${rules.error}`)

  const conditions = parseJsonObject(desired.conditionsRaw)
  if (conditions.error) errors.push(`conditions: ${conditions.error}`)

  const bypass = parseJsonArray(desired.bypassActorsRaw)
  if (bypass.error) errors.push(`bypass_actors: ${bypass.error}`)

  const body: Record<string, unknown> = {
    name: desired.name,
    target: desired.target,
    enforcement: desired.enforcement,
    rules: rules.value,
  }
  if (conditions.value && Object.keys(conditions.value).length > 0) body.conditions = conditions.value
  if (bypass.value.length > 0) body.bypass_actors = bypass.value

  return { body, errors }
}

/** Reconstruct the PUT body that restores a prior ruleset. */
export function restoreBody(prior: LiveRuleset): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: prior.name ?? '',
    target: prior.target ?? 'branch',
    enforcement: prior.enforcement ?? 'active',
    rules: Array.isArray(prior.rules) ? prior.rules : [],
  }
  if (prior.conditions && Object.keys(prior.conditions).length > 0) body.conditions = prior.conditions
  if (Array.isArray(prior.bypass_actors) && prior.bypass_actors.length > 0) body.bypass_actors = prior.bypass_actors
  return body
}

/** Deterministic JSON for comparing rules / conditions / bypass_actors across a diff. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`
}

/** What deploy records per ruleset so rollback / reconcile can restore or delete it. */
export interface RulesetRollbackEntry {
  itemId?: string
  owner: string
  repository: string
  name: string
  /** Whether the ruleset existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  /** GitHub-assigned numeric id, kept so rollback / reconcile target it directly. */
  id?: number
  /** The full prior ruleset (existed=true only) so rollback can PUT it back. */
  prior?: LiveRuleset
}
