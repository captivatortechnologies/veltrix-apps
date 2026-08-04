// =============================================================================
// Shared types + helpers for the Datadog Sensitive Data Scanner (DLP) config
// type.
//
// Verified against the official Datadog API docs (a JSON:API resource graph:
// ONE org-wide "configuration" singleton -> many scanning GROUPS -> many
// scanning RULES per group):
//   Read the whole config: GET /api/v2/sensitive-data-scanner/config
//     -> { data: { id: <configId>, type: "sensitive_data_scanner_configuration",
//          relationships: { groups: { data: [{id,type}] } } },
//          included: [ <every live group AND rule, each { id, type,
//          attributes, relationships } > ],
//          meta: { version, ... } }
//   Create group:  POST  /api/v2/sensitive-data-scanner/config/groups
//     body: { meta: {}, data: { type: "sensitive_data_scanner_group",
//       attributes: { name, description?, is_enabled, product_list, filter:
//       { query } }, relationships: { configuration: { data: { type:
//       "sensitive_data_scanner_configuration", id: <configId> } },
//       rules: { data: [] } } } }   — rules MUST be [] at group-create time;
//       rules are created afterward via their own endpoint.
//   Update group:  PATCH  /api/v2/sensitive-data-scanner/config/groups/{group_id}
//   Delete group:  DELETE /api/v2/sensitive-data-scanner/config/groups/{group_id}
//   Create rule:   POST  /api/v2/sensitive-data-scanner/config/rules
//     body: { meta: {}, data: { type: "sensitive_data_scanner_rule",
//       attributes: { name, description?, is_enabled, priority,
//       pattern?, namespaces?, excluded_namespaces?, tags?,
//       included_keyword_configuration?, text_replacement? },
//       relationships: { group: { data: { type: "sensitive_data_scanner_group",
//       id: <groupId> } } [, standard_pattern: { data: { type:
//       "sensitive_data_scanner_standard_pattern", id: <patternId> } } ] } } }
//     — exactly ONE of attributes.pattern (a custom regex) OR
//     relationships.standard_pattern (a built-in pattern id, from
//     GET /api/v2/sensitive-data-scanner/config/standard-patterns) is set.
//   Update rule:   PATCH  /api/v2/sensitive-data-scanner/config/rules/{rule_id}
//   Delete rule:   DELETE /api/v2/sensitive-data-scanner/config/rules/{rule_id}
// https://docs.datadoghq.com/api/latest/sensitive-data-scanner/
//
// NOT MANAGED (flagged, not faked): group/rule ORDERING — a separate
// PATCH /api/v2/sensitive-data-scanner/config on the configuration singleton
// itself reorders groups (and implicitly the rules within). Out of scope for
// this release; a newly created group/rule is appended and may need manual
// reordering.
//
// This app models ONE canvas item = ONE scanning GROUP, with its rules
// authored as a nested JSON array (the `relationships.group` wrapper each
// rule needs is added implicitly by deploy.ts — the author never writes it).
// A rule's `standard_pattern_id` is a convenience key THIS APP recognizes in
// the authored JSON (not a real Datadog attribute) that deploy.ts translates
// into `relationships.standard_pattern` on write, and strips out again when
// reading live rules back for comparison.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

export const PRODUCTS = ['logs', 'rum', 'events', 'apm'] as const
export const TEXT_REPLACEMENT_TYPES = [
  'none',
  'hash',
  'replacement_string',
  'partial_replacement_from_beginning',
  'partial_replacement_from_end',
] as const
export const MIN_PRIORITY = 1
export const MAX_PRIORITY = 5
export const MAX_NAME_LENGTH = 255

// --- Resource shapes -------------------------------------------------------------

export interface ScannerGroupAttributes {
  name?: string
  description?: string
  is_enabled?: boolean
  product_list?: string[]
  filter?: { query?: string }
  [key: string]: unknown
}

export interface ScannerResourceRef {
  id?: string
  type?: string
}

export interface ScannerGroupResource {
  id?: string
  type?: string
  attributes?: ScannerGroupAttributes
  relationships?: { rules?: { data?: ScannerResourceRef[] } }
}

export interface ScannerRuleAttributes {
  name?: string
  description?: string
  is_enabled?: boolean
  priority?: number
  pattern?: string
  namespaces?: string[]
  excluded_namespaces?: string[]
  tags?: string[]
  included_keyword_configuration?: { keywords?: string[]; character_count?: number }
  text_replacement?: { type?: string; replacement_string?: string; number_of_chars?: number }
  [key: string]: unknown
}

export interface ScannerRuleResource {
  id?: string
  type?: string
  attributes?: ScannerRuleAttributes
  relationships?: { group?: { data?: ScannerResourceRef }; standard_pattern?: { data?: ScannerResourceRef } }
}

export interface ScannerConfigResource {
  id?: string
  type?: string
  relationships?: { groups?: { data?: ScannerResourceRef[] } }
}

/** The whole GET .../config response, JSON:API side-loaded. */
export interface ScannerConfigResponse {
  data?: ScannerConfigResource
  included?: Array<ScannerGroupResource | ScannerRuleResource>
  meta?: { version?: number; [key: string]: unknown }
}

export function isGroupResource(r: ScannerGroupResource | ScannerRuleResource): r is ScannerGroupResource {
  return r.type === 'sensitive_data_scanner_group'
}
export function isRuleResource(r: ScannerGroupResource | ScannerRuleResource): r is ScannerRuleResource {
  return r.type === 'sensitive_data_scanner_rule'
}

// --- Write bodies ------------------------------------------------------------------

export interface GroupBody {
  name: string
  description: string
  is_enabled: boolean
  product_list: string[]
  filter: { query: string }
}

export interface RuleBody extends ScannerRuleAttributes {
  name: string
  is_enabled: boolean
  priority: number
}

// --- Canvas item -> spec -----------------------------------------------------------

export interface GroupSpec {
  name: string
  description: string
  isEnabled: boolean
  productList: string[]
  filterQuery: string
  rulesRaw: string
}

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

export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

export function extractGroupSpec(fields: Record<string, unknown>): GroupSpec {
  const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  return {
    name: str(fields.name),
    description: str(fields.description),
    isEnabled: readBool(fields.is_enabled, true),
    productList: readStringArray(fields.product_list),
    filterQuery: str(fields.filter_query) || '*',
    rulesRaw: typeof fields.rules === 'string' ? fields.rules.trim() : '',
  }
}

export function extractGroupSpecs(canvas: CanvasSnapshot): GroupSpec[] {
  const items = (canvas.items ?? canvas.sections ?? []) as Array<{ fields?: Record<string, unknown> }>
  return items.map((item) => extractGroupSpec(item.fields ?? {}))
}

export function groupKey(name: string): string {
  return name.trim().toLowerCase()
}
export function ruleKey(name: string): string {
  return name.trim().toLowerCase()
}

export function findGroupByName(groups: ScannerGroupResource[], name: string): ScannerGroupResource | null {
  const key = groupKey(name)
  if (!key) return null
  return groups.find((g) => typeof g.attributes?.name === 'string' && groupKey(g.attributes.name) === key) ?? null
}

// --- JSON parsing ------------------------------------------------------------------

export interface ParsedJson<T> {
  value: T | undefined
  ok: boolean
}

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

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// --- Body construction ---------------------------------------------------------------

export function buildGroupBody(spec: GroupSpec): GroupBody {
  return {
    name: spec.name,
    description: spec.description,
    is_enabled: spec.isEnabled,
    product_list: spec.productList,
    filter: { query: spec.filterQuery },
  }
}

export function groupAttributesToBody(attrs: ScannerGroupAttributes): GroupBody {
  return {
    name: String(attrs.name ?? ''),
    description: String(attrs.description ?? ''),
    is_enabled: attrs.is_enabled ?? true,
    product_list: Array.isArray(attrs.product_list) ? attrs.product_list : [],
    filter: { query: String(attrs.filter?.query ?? '*') },
  }
}

/** One authored rule object from the canvas JSON array — the raw shape before `standard_pattern_id` extraction. */
export interface RawRuleJson extends Record<string, unknown> {
  name?: string
  standard_pattern_id?: string
}

/** Build the write body for one rule, extracting the synthetic `standard_pattern_id` convenience key. */
export function buildRuleBody(raw: RawRuleJson): { body: RuleBody; standardPatternId: string | null } {
  const { standard_pattern_id, ...rest } = raw
  const body: RuleBody = {
    ...rest,
    name: typeof raw.name === 'string' ? raw.name : '',
    is_enabled: readBool(raw.is_enabled, true),
    priority: typeof raw.priority === 'number' ? raw.priority : 3,
  }
  return { body, standardPatternId: typeof standard_pattern_id === 'string' && standard_pattern_id ? standard_pattern_id : null }
}

/** Rebuild a rule write body from a captured LIVE rule resource (rollback restore path). */
export function ruleResourceToBody(rule: ScannerRuleResource): { body: RuleBody; standardPatternId: string | null } {
  const attrs = rule.attributes ?? {}
  const body: RuleBody = {
    ...attrs,
    name: String(attrs.name ?? ''),
    is_enabled: attrs.is_enabled ?? true,
    priority: typeof attrs.priority === 'number' ? attrs.priority : 3,
  }
  const standardPatternId = rule.relationships?.standard_pattern?.data?.id ?? null
  return { body, standardPatternId }
}
