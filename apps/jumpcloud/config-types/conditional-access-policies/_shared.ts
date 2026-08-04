// Shared helpers for the JumpCloud Conditional Access (Authentication) Policies
// config type (validate + deploy + rollback + healthCheck + driftDetect).
//
// Applied over the JumpCloud API v2 (/authn/policies) — JumpCloud's Conditional
// Access mechanism.
//
// VERIFIED against JumpCloud's published API v2 OpenAPI spec
// (github.com/TheJumpCloud/jumpcloud-docs-public, docs/api/2.0/index.yaml):
//   AuthnPolicy: { id, name, description, disabled, monitorOnly, effect, targets, type, conditions }
//   AuthnPolicyEffect: { action: "allow"|"deny"|"unknown", obligations?, custom_error_message? }
//   AuthnPolicyType: "user_portal" | "application" | "ldap" | "admin_portal"
//   targets / conditions are compound objects — see canvas.yaml helpText for the
//   exact grammar (taken verbatim from the API's own documentation).

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

export const AUTHN_POLICY_TYPES = ['user_portal', 'application', 'ldap', 'admin_portal'] as const
export type AuthnPolicyType = (typeof AUTHN_POLICY_TYPES)[number]

export const AUTHN_POLICY_ACTIONS = ['allow', 'deny'] as const
export type AuthnPolicyAction = (typeof AUTHN_POLICY_ACTIONS)[number]

/** One JumpCloud Authentication Policy as returned by GET /authn/policies[/{id}]. */
export interface JumpCloudAuthnPolicy {
  id?: string
  name?: string
  description?: string
  disabled?: boolean
  monitorOnly?: boolean
  effect?: { action?: string; obligations?: { mfa?: { required?: boolean }; [key: string]: unknown }; [key: string]: unknown }
  targets?: Record<string, unknown>
  type?: string
  conditions?: Record<string, unknown>
  [key: string]: unknown
}

/** The desired state for one Authentication Policy, extracted from a canvas item. */
export interface ConditionalAccessPolicySpec {
  itemId?: string
  name: string
  description: string
  type: string
  disabled: boolean
  monitorOnly: boolean
  action: string
  mfaRequired: boolean
  /** Raw `targets` JSON exactly as typed in the canvas. */
  targetsRaw: string
  /** Raw `conditions` JSON exactly as typed in the canvas. */
  conditionsRaw: string
}

/** Coerce a checkbox-ish value to a boolean (default false). */
export function normalizeBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes') return true
  if (s === 'false' || s === '0' || s === 'no') return false
  return fallback
}

/** Each canvas item describes one JumpCloud Authentication Policy. */
export function extractConditionalAccessPolicySpecs(canvas: CanvasSnapshot): ConditionalAccessPolicySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      itemId: item.id,
      name: String(fields.name ?? '').trim(),
      description: String(fields.description ?? '').trim(),
      type: String(fields.type ?? '').trim(),
      disabled: normalizeBool(fields.disabled, false),
      monitorOnly: normalizeBool(fields.monitorOnly, false),
      action: String(fields.action ?? 'allow').trim() || 'allow',
      mfaRequired: normalizeBool(fields.mfaRequired, false),
      targetsRaw: String(fields.targetsRaw ?? '').trim(),
      conditionsRaw: String(fields.conditionsRaw ?? '').trim(),
    }
  })
}

export interface ParsedJsonObject {
  value: Record<string, unknown>
  error?: string
}

/**
 * Parse a raw JSON-object field (targets / conditions). An empty string parses
 * to `{}` (an unconditional / all-resources policy). Returns an `error` string
 * instead of throwing on malformed / wrong-shaped content so validate.ts can
 * surface it as a field error.
 */
export function parseJsonObjectField(raw: string, fieldLabel: string): ParsedJsonObject {
  const text = raw.trim()
  if (!text) return { value: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { value: {}, error: `${fieldLabel} is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}` }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: {}, error: `${fieldLabel} must be a JSON object.` }
  }
  return { value: parsed as Record<string, unknown> }
}

/** Find a live Authentication Policy by name (case-insensitive — the stable identity). */
export function findAuthnPolicyByName(policies: JumpCloudAuthnPolicy[], name: string): JumpCloudAuthnPolicy | null {
  const target = name.trim().toLowerCase()
  if (!target) return null
  return policies.find((p) => String(p.name ?? '').trim().toLowerCase() === target) ?? null
}

/**
 * Build the JumpCloud AuthnPolicy body for POST/PATCH /authn/policies[/{id}].
 * `targets` / `conditions` are sent exactly as declared (parsed JSON, `{}` when
 * left empty). `type` is only sent on create — it cannot be changed after
 * creation, so PATCH omits it to avoid the API rejecting a redundant/immutable
 * field (FLAGGED — verify PATCH's tolerance of a same-value `type` on a live tenant).
 */
export function buildAuthnPolicyBody(
  spec: ConditionalAccessPolicySpec,
  targets: Record<string, unknown>,
  conditions: Record<string, unknown>,
  opts: { includeType: boolean },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
    disabled: spec.disabled,
    monitorOnly: spec.monitorOnly,
    effect: { action: spec.action, obligations: { mfa: { required: spec.mfaRequired } } },
    targets,
    conditions,
  }
  if (opts.includeType) body.type = spec.type
  return body
}

/** The subset of a live policy's fields this config type manages — captured for rollback. */
export function priorFieldsOf(policy: JumpCloudAuthnPolicy): Record<string, unknown> {
  return {
    name: String(policy.name ?? ''),
    description: String(policy.description ?? ''),
    disabled: Boolean(policy.disabled),
    monitorOnly: Boolean(policy.monitorOnly),
    effect: policy.effect ?? { action: 'allow' },
    targets: policy.targets ?? {},
    conditions: policy.conditions ?? {},
  }
}
