// Shared helpers for the Sysdig Secure Runtime Policies config type
// (validate + deploy + rollback + drift).
//
// Policy shapes follow the Sysdig Secure /api/v2/policies API (confirmed against
// terraform-provider-sysdig model.go + python-sdc-client). Verify against a live
// Sysdig Secure.

import type { PolicyAction, SysdigPolicy } from '../../lib/sysdigApi'

/** Policy type for a rule-referencing runtime policy. */
export const POLICY_TYPE_FALCO = 'falco'

/**
 * Valid severity levels, mapped to the Sysdig integer scale (0–7 syslog levels,
 * 0 = most severe). These are the same eight levels Falco rule priorities use.
 */
export const SEVERITY_BY_NAME: Record<string, number> = {
  EMERGENCY: 0,
  ALERT: 1,
  CRITICAL: 2,
  ERROR: 3,
  WARNING: 4,
  NOTICE: 5,
  INFO: 6,
  DEBUG: 7,
}

/**
 * Response actions this app supports, keyed by the short canvas value. CAPTURE
 * is intentionally excluded — it requires bucket/file configuration the canvas
 * does not collect. An empty action list is a valid notify-only policy.
 */
export const ACTION_TYPE_BY_KEY: Record<string, string> = {
  stop: 'POLICY_ACTION_STOP',
  pause: 'POLICY_ACTION_PAUSE',
  kill: 'POLICY_ACTION_KILL',
}

/** The canvas fields for one runtime policy item. */
export interface PolicyFields {
  name?: unknown
  description?: unknown
  enabled?: unknown
  severity?: unknown
  ruleNames?: unknown
  actions?: unknown
  scope?: unknown
}

/**
 * `enabled` may arrive as a boolean, an 'enabled'/'disabled' string, or 1|0 —
 * normalize to a boolean. Defaults to enabled.
 */
export function normalizeEnabled(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  if (s === 'disabled' || s === 'false' || s === '0' || s === 'no') return false
  return true
}

/** Split a comma/newline separated value (or array) into trimmed strings. */
export function splitList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  if (typeof value === 'string') {
    return value
      .split(/[,\n]/)
      .map((v) => v.trim())
      .filter(Boolean)
  }
  return []
}

/**
 * Normalize a severity value (a level name like "WARNING", or a 0–7 number /
 * numeric string) to the Sysdig integer scale. Falls back to 4 (WARNING).
 */
export function normalizeSeverity(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  const s = String(value ?? '').trim()
  if (/^[0-7]$/.test(s)) return Number(s)
  const byName = SEVERITY_BY_NAME[s.toUpperCase()]
  return byName ?? 4
}

/** Map canvas action keys to Sysdig policy action objects (unknown keys dropped). */
export function buildActions(value: unknown): PolicyAction[] {
  return splitList(value)
    .map((key) => ACTION_TYPE_BY_KEY[key.toLowerCase()])
    .filter((type): type is string => Boolean(type))
    .map((type) => ({ type }))
}

/** Build the Sysdig policy body from canvas fields. */
export function buildPolicyBody(fields: PolicyFields): SysdigPolicy {
  const scope = String(fields.scope ?? '').trim()
  return {
    name: String(fields.name ?? '').trim(),
    description: String(fields.description ?? '').trim(),
    enabled: normalizeEnabled(fields.enabled),
    severity: normalizeSeverity(fields.severity),
    ruleNames: splitList(fields.ruleNames),
    actions: buildActions(fields.actions),
    scope: scope || undefined,
    type: POLICY_TYPE_FALCO,
    notificationChannelIds: [],
  }
}

/** Find a live policy by exact name (case-sensitive, as Sysdig stores it). */
export function findPolicyByName(policies: SysdigPolicy[], name: string): SysdigPolicy | null {
  const n = name.trim()
  if (!n) return null
  return policies.find((p) => String(p.name ?? '').trim() === n) ?? null
}

/** The sorted rule-name set of a live policy, for stable comparison. */
export function ruleNamesOf(policy: SysdigPolicy | null): string[] {
  return [...(policy?.ruleNames ?? [])].map((r) => String(r).trim()).filter(Boolean).sort()
}

/** The sorted action-type set of a live policy, for stable comparison. */
export function actionTypesOf(policy: SysdigPolicy | null): string[] {
  return [...(policy?.actions ?? [])].map((a) => String(a?.type ?? '').trim()).filter(Boolean).sort()
}
