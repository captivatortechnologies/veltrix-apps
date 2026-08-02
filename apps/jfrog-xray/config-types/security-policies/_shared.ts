// =============================================================================
// Shared types + helpers for the JFrog Xray Security Policies config type.
// Pure and network-free so validate.ts, deploy.ts, driftDetect.ts and the tests
// all read a canvas item and build an Xray policy body the same way.
//
// A canvas item = one Xray security policy = one PRIMARY rule authored through
// typed fields (the common case — a single severity/CVSS gate), plus two JSON
// escape valves for anything the typed fields don't cover:
//   - criteria_json / actions_json — extra keys merged into the primary rule's
//     criteria / actions (e.g. vulnerability_ids, exposures, custom_severity).
//   - additional_rules_json — extra, fully independent rules appended after the
//     primary one, for multi-tier policies (e.g. "Critical fails the build,
//     High only notifies"). Each entry is a full { name, criteria, actions }.
// Typed fields always win over a colliding JSON key so the visible UI state is
// never silently overridden by stale JSON.
//
// The ACTIONS block (shared verbatim with license-policies — see
// lib/xrayPolicies.ts) lives in the shared module; only CRITERIA (the
// severity/CVSS gate) is specific to a security policy.
//
// Schema verified against the JFrog Xray REST API v2 policy reference and
// JFrog's own Terraform provider (see config-types/security-policies/deploy.ts
// header for citations).
// =============================================================================

import type { CanvasItemSnapshot, CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { parseJsonArray, parseJsonObject, readBool, readOptionalNumber, readOptionalString, readString } from '../../lib/fields'
import {
  buildPolicyActions,
  extractPolicyActionFields,
  findPolicyByName,
  policyKey,
  type PolicyActionFields,
  type XrayPolicy,
  type XrayPolicyActions,
  type XrayPolicyRule,
} from '../../lib/xrayPolicies'

/** The `min_severity` values Xray accepts (verified casing — see deploy.ts citations). */
export const MIN_SEVERITIES = ['All Severities', 'Critical', 'High', 'Medium', 'Low'] as const
export type MinSeverity = (typeof MIN_SEVERITIES)[number]

// --- Xray security-policy wire shapes (criteria is security-specific) --------

export interface XrayCvssRange {
  from: number
  to: number
}

export interface XraySecurityCriteria {
  min_severity?: string
  cvss_range?: XrayCvssRange
  malicious_package?: boolean
  applicable_cves_only?: boolean
  fix_version_dependant?: boolean
  [extra: string]: unknown
}

export type XraySecurityRule = XrayPolicyRule<XraySecurityCriteria>
export type XraySecurityPolicy = XrayPolicy<XraySecurityCriteria>
// Re-exported so deploy/rollback/healthCheck/driftDetect share one action shape.
export type { XrayPolicyActions }

// --- Canvas spec extraction ----------------------------------------------------

export interface PolicySpec extends PolicyActionFields {
  itemLabel: string
  name: string
  description?: string
  ruleName: string
  priority?: number
  useCvssRange: boolean
  minSeverity: string
  cvssFrom?: number
  cvssTo?: number
  maliciousPackage: boolean
  applicableCvesOnly: boolean
  fixVersionDependant: boolean
  criteriaJson: string
  additionalRulesJson: string
}

/** Read every canvas item as a `PolicySpec`. Tolerates the `items`/`sections` alias. */
export function extractPolicySpecs(canvas: CanvasSnapshot): PolicySpec[] {
  const items: CanvasItemSnapshot[] = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      ...extractPolicyActionFields(f),
      itemLabel: item.name || readString(f.name) || '(unnamed)',
      name: readString(f.name),
      description: readOptionalString(f.description),
      ruleName: readString(f.rule_name),
      priority: readOptionalNumber(f.priority),
      useCvssRange: readBool(f.use_cvss_range, false),
      minSeverity: readString(f.min_severity) || 'High',
      cvssFrom: readOptionalNumber(f.cvss_from),
      cvssTo: readOptionalNumber(f.cvss_to),
      maliciousPackage: readBool(f.malicious_package, false),
      applicableCvesOnly: readBool(f.applicable_cves_only, false),
      fixVersionDependant: readBool(f.fix_version_dependant, false),
      criteriaJson: typeof f.criteria_json === 'string' ? f.criteria_json : '',
      additionalRulesJson: typeof f.additional_rules_json === 'string' ? f.additional_rules_json : '',
    }
  })
}

export { policyKey }

/** Build the primary rule's `criteria` object from the typed fields + the JSON escape valve. */
export function buildCriteria(spec: PolicySpec): XraySecurityCriteria {
  const criteria: XraySecurityCriteria = {}
  if (spec.useCvssRange) {
    if (spec.cvssFrom !== undefined && spec.cvssTo !== undefined) {
      criteria.cvss_range = { from: spec.cvssFrom, to: spec.cvssTo }
    }
  } else if (spec.minSeverity) {
    criteria.min_severity = spec.minSeverity
  }
  if (spec.maliciousPackage) criteria.malicious_package = true
  if (spec.applicableCvesOnly) criteria.applicable_cves_only = true
  if (spec.fixVersionDependant) criteria.fix_version_dependant = true

  const extra = parseJsonObject(spec.criteriaJson)
  return extra.ok ? { ...extra.value, ...criteria } : criteria
}

/** Build the primary rule's `actions` object from the shared typed fields + the JSON escape valve. */
export function buildActions(spec: PolicySpec): XrayPolicyActions {
  return buildPolicyActions(spec)
}

/**
 * Build the primary declared rule (typed fields + JSON escape valves merged in).
 * Falls back to "default-rule" when unset — validate.ts rejects a blank rule
 * name, but deploy must still never send Xray an unnamed rule.
 */
export function buildPrimaryRule(spec: PolicySpec): XraySecurityRule {
  const rule: XraySecurityRule = { name: spec.ruleName || 'default-rule', criteria: buildCriteria(spec), actions: buildActions(spec) }
  if (spec.priority !== undefined) rule.priority = spec.priority
  return rule
}

/** Parse `additional_rules_json` into extra `XraySecurityRule`s appended after the primary rule. */
export function buildAdditionalRules(spec: PolicySpec): XraySecurityRule[] {
  const parsed = parseJsonArray(spec.additionalRulesJson)
  if (!parsed.ok) return []
  const rules: XraySecurityRule[] = []
  for (const entry of parsed.value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const rec = entry as Record<string, unknown>
    const name = readString(rec.name)
    if (!name) continue
    const criteria = rec.criteria && typeof rec.criteria === 'object' && !Array.isArray(rec.criteria) ? (rec.criteria as XraySecurityCriteria) : {}
    const actions = rec.actions && typeof rec.actions === 'object' && !Array.isArray(rec.actions) ? (rec.actions as XrayPolicyActions) : {}
    const rule: XraySecurityRule = { name, criteria, actions }
    const priority = readOptionalNumber(rec.priority)
    if (priority !== undefined) rule.priority = priority
    rules.push(rule)
  }
  return rules
}

/** The full policy body sent on POST (create) / PUT (update). */
export function buildPolicyBody(spec: PolicySpec): XraySecurityPolicy {
  const body: XraySecurityPolicy = {
    name: spec.name,
    type: 'security',
    rules: [buildPrimaryRule(spec), ...buildAdditionalRules(spec)],
  }
  if (spec.description) body.description = spec.description
  return body
}

/** Find a live policy by name (exact match — Xray policy names are case-sensitive). */
export function findPolicy(policies: XraySecurityPolicy[], name: string): XraySecurityPolicy | undefined {
  return findPolicyByName(policies, name)
}
