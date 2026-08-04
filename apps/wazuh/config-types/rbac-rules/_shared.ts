// Shared helpers for the Wazuh RBAC-rules config type (validate + deploy +
// drift). An RBAC (security) rule is a named authentication-context matching
// condition (Wazuh's FIND/MATCH grammar), attached to one or more roles (see
// the API Roles config type). NOT the ruleset "Custom Rules" config type. The
// canvas `comment` field is audit-only and is never sent to the manager.
//
// Field shapes verified against the Wazuh API OpenAPI spec (api/api/spec/spec.yaml,
// tag v4.14.7, github.com/wazuh/wazuh) — `SecurityRulesRequest` schema, whose
// `rule` property is declared `type: object` with no further shape constraint
// (an arbitrary nested JSON condition tree) — passed through as declared, same
// as this app's XML config-type bodies.

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'

/** An RBAC rule/role/policy name: Wazuh's `names` OpenAPI format (`^[\w.%-]+$`, ASCII). */
export const NAME_RE = /^[\w.%-]+$/
export const MAX_NAME_LENGTH = 64

export interface RbacRuleSpec {
  name: string
  rule: Record<string, unknown> | null
  ruleParseError: string | null
  comment: string
}

/** Parse the rule-definition textarea as JSON; must be a non-null, non-array plain object. */
export function parseRuleDefinition(text: unknown): { rule: Record<string, unknown> | null; error: string | null } {
  const raw = String(text ?? '').trim()
  if (!raw) return { rule: null, error: 'empty' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { rule: null, error: e instanceof Error ? e.message : 'invalid JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { rule: null, error: 'must be a JSON object' }
  }
  return { rule: parsed as Record<string, unknown>, error: null }
}

export function specFromItem(item: CanvasItemSnapshot): RbacRuleSpec {
  const { rule, error } = parseRuleDefinition(item.fields.ruleDefinition)
  return {
    name: String(item.fields.name ?? '').trim(),
    rule,
    ruleParseError: error,
    comment: String(item.fields.comment ?? '').trim(),
  }
}

/** The wire body for POST/PUT `/security/rules` — `{ name, rule }`. */
export function toRuleBody(spec: RbacRuleSpec): { name: string; rule: Record<string, unknown> } {
  return { name: spec.name, rule: spec.rule ?? {} }
}

/** Deep, key-order-insensitive equality for the declared vs. live `rule` JSON object. */
export function ruleEquals(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b)
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}
