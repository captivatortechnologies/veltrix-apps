// Shared helpers for the Sysdig Secure Managed Policies config type
// (validate + deploy + rollback + drift).
//
// A managed policy is Sysdig-provided content: it is looked up by name+type
// among /api/v2/policies (isDefault === true identifies it — confirmed against
// terraform-provider-sysdig's resource_sysdig_secure_managed_policy.go, which
// requires the same flag) and only ever UPDATED, never created or deleted.
// Verify against a live Sysdig Secure.

import type { PolicyAction, SysdigPolicy, SysdigPolicyRuleToggle } from '../../lib/sysdigApi'

/** Runtime policy `type` values a managed policy may declare. */
export const POLICY_TYPES = new Set(['falco', 'k8s_audit', 'aws_cloudtrail', 'gcp_auditlog', 'azure_platformlogs', 'okta', 'github', 'guardduty'])

/** Response actions this app supports (CAPTURE excluded — needs bucket/file config the canvas does not collect). */
export const ACTION_TYPE_BY_KEY: Record<string, string> = {
  stop: 'POLICY_ACTION_STOP',
  pause: 'POLICY_ACTION_PAUSE',
  kill: 'POLICY_ACTION_KILL',
}

export interface ManagedPolicyFields {
  name?: unknown
  type?: unknown
  enabled?: unknown
  runbook?: unknown
  scope?: unknown
  actions?: unknown
  notificationChannelIds?: unknown
  disabledRuleNames?: unknown
}

export function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === null || value === '') return fallback
  const s = String(value).trim().toLowerCase()
  if (s === 'false' || s === '0' || s === 'no') return false
  if (s === 'true' || s === '1' || s === 'yes') return true
  return fallback
}

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

export function splitNumericList(value: unknown): number[] {
  return splitList(value)
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n))
}

/** Map canvas action keys to Sysdig policy action objects (unknown keys dropped). */
export function buildActions(value: unknown): PolicyAction[] {
  return splitList(value)
    .map((key) => ACTION_TYPE_BY_KEY[key.toLowerCase()])
    .filter((type): type is string => Boolean(type))
    .map((type) => ({ type }))
}

/** The response-action canvas keys a live policy's actions currently represent. */
export function actionKeysOf(policy: SysdigPolicy | null): string[] {
  const byType = new Map(Object.entries(ACTION_TYPE_BY_KEY).map(([k, v]) => [v, k]))
  return [...(policy?.actions ?? [])]
    .map((a) => byType.get(String(a?.type ?? '')))
    .filter((k): k is string => Boolean(k))
    .sort()
}

/** Find a live MANAGED (isDefault) policy by exact name + type. */
export function findManagedPolicy(policies: SysdigPolicy[], name: string, type: string): SysdigPolicy | null {
  const n = name.trim()
  if (!n) return null
  return policies.find((p) => p.isDefault === true && String(p.name ?? '').trim() === n && String(p.type ?? '').trim() === type) ?? null
}

/**
 * Apply this app's declared tuning onto a LIVE managed policy, toggling only
 * the rules named in `disabledRuleNames` off and leaving every other rule as
 * the live policy already has it (so unrelated managed content is untouched).
 */
export function applyTuning(existing: SysdigPolicy, fields: ManagedPolicyFields): SysdigPolicy {
  const disabled = new Set(splitList(fields.disabledRuleNames))
  const rules: SysdigPolicyRuleToggle[] = (existing.rules ?? []).map((r) => ({
    ruleName: r.ruleName,
    enabled: !disabled.has(r.ruleName),
  }))
  return {
    ...existing,
    enabled: true,
    runbook: String(fields.runbook ?? '').trim(),
    scope: String(fields.scope ?? '').trim() || undefined,
    actions: buildActions(fields.actions),
    notificationChannelIds: splitNumericList(fields.notificationChannelIds),
    rules,
  }
}

/** The reset Terraform's own managed-policy Delete performs — see the go source. */
export function resetTuning(existing: SysdigPolicy): SysdigPolicy {
  return {
    ...existing,
    enabled: false,
    runbook: '',
    scope: '',
    actions: [],
    notificationChannelIds: [],
    rules: (existing.rules ?? []).map((r) => ({ ruleName: r.ruleName, enabled: true })),
  }
}
