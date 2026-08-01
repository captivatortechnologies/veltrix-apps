// Shared helpers for the SonarQube Quality Gates config type (validate + deploy +
// rollback + drift). Pure and network-free so validate.ts and the tests can use it.
//
// A quality gate is authored as a name, a default flag, and a free-text block of
// conditions — one per line, `<metric> <OP> <threshold>` (e.g. `new_coverage LT 80`).
// SonarQube allows at most ONE condition per metric per gate, so a condition's
// identity for reconciliation is its metric key. Applied over the SonarQube Web API
// (/api/qualitygates). Verify metric keys/operators against your SonarQube version.

/** The two operators the SonarQube Web API accepts for a condition. */
export const OPERATORS = new Set(['LT', 'GT'])

/** A condition as returned by /api/qualitygates/show ({ id, metric, op, error }). */
export interface SonarCondition {
  id?: string | number
  metric: string
  op: string
  error: string
}

/** A quality gate as returned by /api/qualitygates/list or /show. */
export interface SonarQualityGate {
  id?: string | number
  name?: string
  isDefault?: boolean
  isBuiltIn?: boolean
  conditions?: SonarCondition[]
  [key: string]: unknown
}

/** A condition parsed from one canvas line — the threshold is SonarQube's `error`. */
export interface ParsedCondition {
  metric: string
  op: string
  error: string
}

export interface ConditionParseError {
  line: number
  raw: string
  code: 'INVALID_CONDITION' | 'INVALID_OPERATOR' | 'EMPTY_THRESHOLD'
  message: string
}

export interface ConditionParseResult {
  conditions: ParsedCondition[]
  errors: ConditionParseError[]
}

/**
 * Parse the conditions textarea. Each non-blank line that does not start with `#`
 * must be `<metric> <OP> <threshold>` (whitespace-separated). The operator is
 * upper-cased and must be LT or GT; the threshold must be non-empty. Malformed
 * lines are reported (never silently dropped) so validate can surface them.
 */
export function parseConditions(text: unknown): ConditionParseResult {
  const conditions: ParsedCondition[] = []
  const errors: ConditionParseError[] = []
  const raw = String(text ?? '')

  raw.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return

    const tokens = trimmed.split(/\s+/)
    if (tokens.length !== 3) {
      errors.push({
        line: i + 1,
        raw: trimmed,
        code: 'INVALID_CONDITION',
        message: `Condition "${trimmed}" must be "<metric> <LT|GT> <threshold>" (3 whitespace-separated tokens).`,
      })
      return
    }

    const [metric, opRaw, error] = tokens
    const op = opRaw.toUpperCase()
    if (!OPERATORS.has(op)) {
      errors.push({
        line: i + 1,
        raw: trimmed,
        code: 'INVALID_OPERATOR',
        message: `Operator "${opRaw}" must be LT (is lower than) or GT (is greater than).`,
      })
      return
    }
    if (!error) {
      errors.push({ line: i + 1, raw: trimmed, code: 'EMPTY_THRESHOLD', message: `Condition "${trimmed}" has no threshold.` })
      return
    }

    conditions.push({ metric, op, error })
  })

  return { conditions, errors }
}

/** Render a condition back to its canvas line form. */
export function formatCondition(c: ParsedCondition | SonarCondition): string {
  return `${c.metric} ${c.op} ${c.error}`
}

/**
 * Collapse parsed conditions to one-per-metric (SonarQube's rule), last line wins.
 * Returns the deduped list plus the metrics that appeared more than once (for a
 * validation warning).
 */
export function dedupeByMetric(parsed: ParsedCondition[]): { conditions: ParsedCondition[]; duplicates: string[] } {
  const byMetric = new Map<string, ParsedCondition>()
  const duplicates = new Set<string>()
  for (const c of parsed) {
    if (byMetric.has(c.metric)) duplicates.add(c.metric)
    byMetric.set(c.metric, c)
  }
  return { conditions: [...byMetric.values()], duplicates: [...duplicates] }
}

/** `isDefault` may arrive as a boolean or 'true'/'false' string — normalize. */
export function normalizeBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes'
}

/** Unwrap SonarQube's `{ qualitygates: [...] }` list into a flat array. */
export function gatesFromList(payload: unknown): SonarQualityGate[] {
  if (payload && typeof payload === 'object' && Array.isArray((payload as { qualitygates?: unknown }).qualitygates)) {
    return (payload as { qualitygates: SonarQualityGate[] }).qualitygates
  }
  return []
}

/** Find a live gate by name (SonarQube gate names are case-sensitive). */
export function findGate(gates: SonarQualityGate[], name: string): SonarQualityGate | null {
  const n = name.trim()
  return gates.find((g) => String(g.name ?? '').trim() === n) ?? null
}

/** The name of the currently-default gate, if any (used to restore on rollback). */
export function defaultGateName(gates: SonarQualityGate[]): string | null {
  const def = gates.find((g) => g.isDefault === true)
  return def?.name ? String(def.name) : null
}

export interface ConditionReconcile {
  toCreate: ParsedCondition[]
  toUpdate: Array<{ live: SonarCondition; desired: ParsedCondition }>
  toDelete: SonarCondition[]
}

/**
 * Reconcile the desired condition set (source of truth) against the live one, keyed
 * by metric: create the missing, update those whose op/threshold changed, delete the
 * live ones the canvas no longer declares.
 */
export function reconcileConditions(desired: ParsedCondition[], live: SonarCondition[]): ConditionReconcile {
  const liveByMetric = new Map<string, SonarCondition>()
  for (const c of live) liveByMetric.set(c.metric, c)

  const desiredByMetric = new Map<string, ParsedCondition>()
  for (const c of desired) desiredByMetric.set(c.metric, c)

  const toCreate: ParsedCondition[] = []
  const toUpdate: Array<{ live: SonarCondition; desired: ParsedCondition }> = []
  for (const [metric, want] of desiredByMetric) {
    const have = liveByMetric.get(metric)
    if (!have) {
      toCreate.push(want)
    } else if (String(have.op) !== want.op || String(have.error) !== want.error) {
      toUpdate.push({ live: have, desired: want })
    }
  }

  const toDelete: SonarCondition[] = []
  for (const [metric, have] of liveByMetric) {
    if (!desiredByMetric.has(metric)) toDelete.push(have)
  }

  return { toCreate, toUpdate, toDelete }
}
