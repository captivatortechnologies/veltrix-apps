// =============================================================================
// Shared types + helpers for the Datadog Security Monitoring Rules config type
// (validate + deploy + rollback + healthCheck + driftDetect).
//
// Rule shape verified against the official Datadog API docs:
//   List:   GET    /api/v2/security_monitoring/rules
//           https://docs.datadoghq.com/api/latest/security-monitoring/get-a-list-of-security-monitoring-rules/
//   Get:    GET    /api/v2/security_monitoring/rules/{rule_id}
//           https://docs.datadoghq.com/api/latest/security-monitoring/get-a-rules-details/
//   Create: POST   /api/v2/security_monitoring/rules
//           https://docs.datadoghq.com/api/latest/security-monitoring/create-a-detection-rule/
//   Update: PUT    /api/v2/security_monitoring/rules/{rule_id}
//           https://docs.datadoghq.com/api/latest/security-monitoring/update-an-existing-rule/
//           ("When updating cases, queries or options, the whole field must be
//           included" — this app always sends the FULL field, never a patch.)
//   Delete: DELETE /api/v2/security_monitoring/rules/{rule_id}
//           (204 No Content; default/built-in rules cannot be deleted)
// Enum values (type / aggregation / dataSource / status / detectionMethod /
// evaluationWindow-keepAlive-maxSignalDuration) cross-checked against both the
// create-rule API reference above and the Terraform provider schema:
//   https://registry.terraform.io/providers/DataDog/datadog/latest/docs/resources/security_monitoring_rule
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

// --- Datadog Security Monitoring Rules API constraints ------------------------

/** `type` — verified against the create-rule API reference + Terraform provider schema. */
export const RULE_TYPES = [
  'log_detection',
  'workload_security',
  'application_security',
  'signal_correlation',
  'cloud_configuration',
] as const
export type RuleType = (typeof RULE_TYPES)[number]

/**
 * Rule types that share the "standard" queries/cases/options shape (a `query`
 * string per query, aggregation/dataSource, threshold-style options). This
 * app deep-validates that shape for these types only.
 */
export const STANDARD_QUERY_TYPES: ReadonlySet<string> = new Set([
  'log_detection',
  'workload_security',
  'application_security',
])

/** `cases[].status` — the signal/finding severity. */
export const CASE_STATUSES = ['info', 'low', 'medium', 'high', 'critical'] as const

/** `queries[].aggregation` (standard rule types). */
export const QUERY_AGGREGATIONS = [
  'count',
  'cardinality',
  'sum',
  'max',
  'new_value',
  'geo_data',
  'event_count',
  'none',
] as const

/** `queries[].dataSource` (standard rule types). */
export const QUERY_DATA_SOURCES = [
  'logs',
  'audit',
  'app_sec_spans',
  'spans',
  'security_runtime',
  'network',
  'events',
  'security_signals',
] as const

/** `options.detectionMethod`. */
export const DETECTION_METHODS = [
  'threshold',
  'new_value',
  'anomaly_detection',
  'impossible_travel',
  'hardcoded',
  'third_party',
  'anomaly_threshold',
  'sequence_detection',
] as const

/** Allowed values (seconds) for `options.evaluationWindow` / `keepAlive` / `maxSignalDuration`. */
export const WINDOW_SECONDS = [0, 60, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400] as const

/** `filters[].action`. */
export const FILTER_ACTIONS = ['require', 'suppress'] as const

export const MAX_NAME_LENGTH = 255

// --- Live rule shape ------------------------------------------------------------

/**
 * A Security Monitoring Rule as returned by the API. Only the fields this app
 * reasons about are named; the index signature keeps type-specific extras
 * (e.g. `complianceSignalOptions`) addressable without a cast.
 */
export interface DatadogRule {
  id?: string
  name?: string
  message?: string
  isEnabled?: boolean
  type?: string
  tags?: string[]
  hasExtendedTitle?: boolean
  queries?: unknown[]
  cases?: unknown[]
  options?: Record<string, unknown>
  filters?: unknown[]
  version?: number
  createdAt?: number
  updatedAt?: number
  [key: string]: unknown
}

/** The list endpoint's envelope: `{ "data": [...] }`. A single-rule read/write is NOT wrapped. */
export interface ListRulesResponse {
  data?: DatadogRule[]
  meta?: Record<string, unknown>
}

/** The managed subset of a rule's fields — what this app declares and fully replaces on every deploy. */
export interface RuleBody {
  name: string
  message: string
  type: string
  isEnabled: boolean
  hasExtendedTitle: boolean
  tags: string[]
  queries: unknown[]
  cases: unknown[]
  options: Record<string, unknown>
  filters: unknown[]
  /** Only set on an UPDATE (optimistic-concurrency token); omitted on create. */
  version?: number
}

// --- Canvas item -> spec ---------------------------------------------------------

/** One canvas item's raw (unparsed) fields, plus the modelled scalar/list fields. */
export interface RuleSpec {
  name: string
  message: string
  type: string
  isEnabled: boolean
  hasExtendedTitle: boolean
  tags: string[]
  queriesRaw: string
  casesRaw: string
  optionsRaw: string
  filtersRaw: string
}

/** Coerce a checkbox-ish value to boolean, falling back when unset. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/**
 * Read a `tags`/`multiselect`-shaped value (array) or a comma/newline-separated
 * string into a clean list: trims, drops blanks, and de-duplicates while
 * preserving order (Datadog tags are set-like — a literal duplicate is noise).
 */
export function readStringArray(value: unknown): string[] {
  const raw: string[] = Array.isArray(value)
    ? value.map((v) => (typeof v === 'string' ? v : String(v ?? '')))
    : typeof value === 'string'
      ? value.split(/[\n,]+/)
      : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const trimmed = entry.trim()
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed)
      out.push(trimmed)
    }
  }
  return out
}

/** Extract one rule spec from a canvas item's flat field record. */
export function extractRuleSpec(fields: Record<string, unknown>): RuleSpec {
  const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  return {
    name: str(fields.name),
    message: str(fields.message),
    type: str(fields.type) || 'log_detection',
    isEnabled: readBool(fields.isEnabled, true),
    hasExtendedTitle: readBool(fields.hasExtendedTitle, false),
    tags: readStringArray(fields.tags),
    queriesRaw: typeof fields.queries === 'string' ? fields.queries.trim() : '',
    casesRaw: typeof fields.cases === 'string' ? fields.cases.trim() : '',
    optionsRaw: typeof fields.options === 'string' ? fields.options.trim() : '',
    filtersRaw: typeof fields.filters === 'string' ? fields.filters.trim() : '',
  }
}

/** Extract every rule spec declared on a canvas snapshot (the modern `items` shape, with a `sections` fallback). */
export function extractRuleSpecs(canvas: CanvasSnapshot): RuleSpec[] {
  const items = (canvas.items ?? canvas.sections ?? []) as Array<{ fields?: Record<string, unknown> }>
  return items.map((item) => extractRuleSpec(item.fields ?? {}))
}

/** The rule's logical identity: its name (case-insensitive, trimmed). */
export function ruleKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Find a live rule by name (case-insensitive, trimmed) — the upsert identity. */
export function findRuleByName(rules: DatadogRule[], name: string): DatadogRule | null {
  const key = ruleKey(name)
  if (!key) return null
  return rules.find((r) => typeof r.name === 'string' && ruleKey(r.name) === key) ?? null
}

// --- JSON field parsing ---------------------------------------------------------

export interface ParsedJson<T> {
  value: T | undefined
  ok: boolean
}

/** Parse a JSON array field; empty text is "ok" but undefined (caller treats as missing/required). */
export function parseJsonArray(raw: string): ParsedJson<unknown[]> {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return { value: undefined, ok: true }
  try {
    const parsed = JSON.parse(trimmed)
    if (!Array.isArray(parsed)) return { value: undefined, ok: false }
    return { value: parsed, ok: true }
  } catch {
    return { value: undefined, ok: false }
  }
}

/** Parse a JSON object field; empty text is "ok" but undefined (caller treats as missing/required). */
export function parseJsonObject(raw: string): ParsedJson<Record<string, unknown>> {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return { value: undefined, ok: true }
  try {
    const parsed = JSON.parse(trimmed)
    if (!isJsonObject(parsed)) return { value: undefined, ok: false }
    return { value: parsed, ok: true }
  } catch {
    return { value: undefined, ok: false }
  }
}

/** True when a value is a non-null, non-array JSON object. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// --- Body construction ------------------------------------------------------------

/**
 * Build the full create/update request body from a spec's ALREADY-VALIDATED
 * JSON fields. Callers must re-parse (parseJsonArray/parseJsonObject) rather
 * than trust upstream validation blindly — this function takes the parsed
 * values directly so a caller cannot forget to.
 */
export function buildRuleBody(
  spec: RuleSpec,
  parsed: { queries: unknown[]; cases: unknown[]; options: Record<string, unknown>; filters: unknown[] },
  version?: number,
): RuleBody {
  const body: RuleBody = {
    name: spec.name,
    message: spec.message,
    type: spec.type,
    isEnabled: spec.isEnabled,
    hasExtendedTitle: spec.hasExtendedTitle,
    tags: spec.tags,
    queries: parsed.queries,
    cases: parsed.cases,
    options: parsed.options,
    filters: parsed.filters,
  }
  if (version !== undefined) body.version = version
  return body
}

/** Rebuild a RuleBody from a captured LIVE rule (rollback restore path). */
export function ruleToBody(rule: DatadogRule, version?: number): RuleBody {
  const body: RuleBody = {
    name: String(rule.name ?? ''),
    message: String(rule.message ?? ''),
    type: String(rule.type ?? 'log_detection'),
    isEnabled: rule.isEnabled ?? true,
    hasExtendedTitle: rule.hasExtendedTitle ?? false,
    tags: Array.isArray(rule.tags) ? rule.tags : [],
    queries: Array.isArray(rule.queries) ? rule.queries : [],
    cases: Array.isArray(rule.cases) ? rule.cases : [],
    options: isJsonObject(rule.options) ? rule.options : {},
    filters: Array.isArray(rule.filters) ? rule.filters : [],
  }
  if (version !== undefined) body.version = version
  return body
}

// --- Deep, order-preserving SUBSET comparison (drift) -----------------------------

/**
 * Subset-aware deep equality used for drift: does `actual` satisfy everything
 * `expected` declares? Objects recurse key-by-key (the declared subset must
 * match; the live object may carry EXTRA keys Datadog defaults in, e.g. a
 * case's `name` or `notifications` when left unset). Arrays are compared
 * element-wise at the same index with the same subset semantics (so an extra
 * key the API injects into a nested query/case object is not read as drift),
 * but the array LENGTH must match exactly. Primitives compare by value.
 */
export function deepSubsetEqual(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length !== actual.length) return false
    return expected.every((item, i) => deepSubsetEqual(item, actual[i]))
  }
  if (isJsonObject(expected)) {
    if (!isJsonObject(actual)) return false
    return Object.keys(expected).every((key) => deepSubsetEqual(expected[key], actual[key]))
  }
  return expected === actual
}

/** Deterministic JSON stringify with recursively sorted object keys — for readable diff output. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
