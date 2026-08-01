// Shared helpers for the Sysdig Secure Falco Rules config type
// (validate + deploy + rollback + drift).
//
// Falco rule shapes follow the Sysdig Secure /api/secure/rules API (confirmed
// against the official terraform-provider-sysdig client). Verify against a live
// Sysdig Secure.

import { FALCO_RULE_TYPE, type SysdigRule } from '../../lib/sysdigApi'

/**
 * Valid Falco rule priorities, UPPERCASE (Falco rules-file convention, and the
 * canonical form Sysdig returns). The Sysdig API is case-insensitive on input.
 */
export const PRIORITIES = new Set(['EMERGENCY', 'ALERT', 'CRITICAL', 'ERROR', 'WARNING', 'NOTICE', 'INFO', 'DEBUG'])

/**
 * Valid Falco rule event sources accepted by Sysdig Secure. Mirrors the source
 * enum enforced by the Sysdig Terraform provider.
 */
export const SOURCES = new Set([
  'syscall',
  'k8s_audit',
  'aws_cloudtrail',
  'gcp_auditlog',
  'azure_platformlogs',
  'okta',
  'github',
  'guardduty',
])

/** The canvas fields for one Falco rule item. */
export interface FalcoRuleFields {
  name?: unknown
  description?: unknown
  condition?: unknown
  output?: unknown
  priority?: unknown
  source?: unknown
  enabled?: unknown
  tags?: unknown
}

/**
 * `enabled` may arrive from the canvas as a boolean, an 'enabled'/'disabled'
 * string, or a 1|0 / '1'|'0' — normalize to a boolean. Defaults to enabled.
 */
export function normalizeEnabled(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  if (s === 'disabled' || s === 'false' || s === '0' || s === 'no') return false
  return true
}

/** Split a comma/newline separated tags value (or array) into trimmed strings. */
export function splitTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter(Boolean)
  }
  return []
}

/** Normalize a priority to its canonical UPPERCASE form. */
export function normalizePriority(value: unknown): string {
  return String(value ?? '').trim().toUpperCase()
}

/**
 * Build the Sysdig rule body from canvas fields. `components` is left empty —
 * Sysdig derives the condition UI components server-side from the expression.
 */
export function buildRuleBody(fields: FalcoRuleFields): SysdigRule {
  return {
    name: String(fields.name ?? '').trim(),
    description: String(fields.description ?? '').trim(),
    tags: splitTags(fields.tags),
    details: {
      ruleType: FALCO_RULE_TYPE,
      source: String(fields.source ?? '').trim(),
      output: String(fields.output ?? '').trim(),
      condition: { condition: String(fields.condition ?? '').trim(), components: [] },
      priority: normalizePriority(fields.priority),
      append: false,
    },
  }
}

/** Find a live custom Falco rule by exact name (case-sensitive, as Sysdig stores it). */
export function findRuleByName(rules: SysdigRule[], name: string): SysdigRule | null {
  const n = name.trim()
  if (!n) return null
  return rules.find((r) => String(r.name ?? '').trim() === n) ?? null
}

/** The Falco condition expression of a live rule (unwrapped from its object). */
export function conditionOf(rule: SysdigRule | null): string {
  return String(rule?.details?.condition?.condition ?? '').trim()
}
