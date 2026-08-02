// =============================================================================
// Shared types + helpers for the JFrog Xray License Policies config type.
// Pure and network-free so validate.ts, deploy.ts, driftDetect.ts and the tests
// all read a canvas item and build an Xray policy body the same way.
//
// A license policy is a policy of `type: "license"` against the exact same
// /xray/api/v2/policies endpoints as a security policy — only the CRITERIA
// shape differs (allowed/banned licenses vs a severity/CVSS gate). The ACTIONS
// block and the CRUD-by-name plumbing are shared with security-policies via
// lib/xrayPolicies.ts.
//
// Criteria fields verified against JFrog's own Terraform provider docs:
//   https://github.com/jfrog/terraform-provider-xray/blob/master/docs/resources/license_policy.md
// =============================================================================

import type { CanvasItemSnapshot, CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { parseJsonArray, parseJsonObject, readBool, readOptionalNumber, readOptionalString, readString, readStringArray } from '../../lib/fields'
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

// --- Xray license-policy wire shapes (criteria is license-specific) ----------

export interface XrayLicenseCriteria {
  allowed_licenses?: string[]
  banned_licenses?: string[]
  allow_unknown?: boolean
  multi_license_permissive?: boolean
  [extra: string]: unknown
}

export type XrayLicenseRule = XrayPolicyRule<XrayLicenseCriteria>
export type XrayLicensePolicy = XrayPolicy<XrayLicenseCriteria>
export type { XrayPolicyActions }

// --- Canvas spec extraction ----------------------------------------------------

export interface LicensePolicySpec extends PolicyActionFields {
  itemLabel: string
  name: string
  description?: string
  ruleName: string
  priority?: number
  allowedLicenses: string[]
  bannedLicenses: string[]
  allowUnknown: boolean
  multiLicensePermissive: boolean
  criteriaJson: string
  additionalRulesJson: string
}

/** Read every canvas item as a `LicensePolicySpec`. Tolerates the `items`/`sections` alias. */
export function extractLicensePolicySpecs(canvas: CanvasSnapshot): LicensePolicySpec[] {
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
      allowedLicenses: readStringArray(f.allowed_licenses),
      bannedLicenses: readStringArray(f.banned_licenses),
      allowUnknown: readBool(f.allow_unknown, false),
      multiLicensePermissive: readBool(f.multi_license_permissive, false),
      criteriaJson: typeof f.criteria_json === 'string' ? f.criteria_json : '',
      additionalRulesJson: typeof f.additional_rules_json === 'string' ? f.additional_rules_json : '',
    }
  })
}

export { policyKey }

/** Build the primary rule's `criteria` object from the typed fields + the JSON escape valve. */
export function buildCriteria(spec: LicensePolicySpec): XrayLicenseCriteria {
  const criteria: XrayLicenseCriteria = {}
  if (spec.allowedLicenses.length > 0) criteria.allowed_licenses = spec.allowedLicenses
  if (spec.bannedLicenses.length > 0) criteria.banned_licenses = spec.bannedLicenses
  if (spec.allowUnknown) criteria.allow_unknown = true
  if (spec.multiLicensePermissive) criteria.multi_license_permissive = true

  const extra = parseJsonObject(spec.criteriaJson)
  return extra.ok ? { ...extra.value, ...criteria } : criteria
}

/** Build the primary rule's `actions` object from the shared typed fields + the JSON escape valve. */
export function buildActions(spec: LicensePolicySpec): XrayPolicyActions {
  return buildPolicyActions(spec)
}

/**
 * Build the primary declared rule (typed fields + JSON escape valves merged in).
 * Falls back to "default-rule" when unset — validate.ts rejects a blank rule
 * name, but deploy must still never send Xray an unnamed rule.
 */
export function buildPrimaryRule(spec: LicensePolicySpec): XrayLicenseRule {
  const rule: XrayLicenseRule = { name: spec.ruleName || 'default-rule', criteria: buildCriteria(spec), actions: buildActions(spec) }
  if (spec.priority !== undefined) rule.priority = spec.priority
  return rule
}

/** Parse `additional_rules_json` into extra `XrayLicenseRule`s appended after the primary rule. */
export function buildAdditionalRules(spec: LicensePolicySpec): XrayLicenseRule[] {
  const parsed = parseJsonArray(spec.additionalRulesJson)
  if (!parsed.ok) return []
  const rules: XrayLicenseRule[] = []
  for (const entry of parsed.value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const rec = entry as Record<string, unknown>
    const name = readString(rec.name)
    if (!name) continue
    const criteria = rec.criteria && typeof rec.criteria === 'object' && !Array.isArray(rec.criteria) ? (rec.criteria as XrayLicenseCriteria) : {}
    const actions = rec.actions && typeof rec.actions === 'object' && !Array.isArray(rec.actions) ? (rec.actions as XrayPolicyActions) : {}
    const rule: XrayLicenseRule = { name, criteria, actions }
    const priority = readOptionalNumber(rec.priority)
    if (priority !== undefined) rule.priority = priority
    rules.push(rule)
  }
  return rules
}

/** The full policy body sent on POST (create) / PUT (update). */
export function buildPolicyBody(spec: LicensePolicySpec): XrayLicensePolicy {
  const body: XrayLicensePolicy = {
    name: spec.name,
    type: 'license',
    rules: [buildPrimaryRule(spec), ...buildAdditionalRules(spec)],
  }
  if (spec.description) body.description = spec.description
  return body
}

/** Find a live policy by name (exact match — Xray policy names are case-sensitive). */
export function findPolicy(policies: XrayLicensePolicy[], name: string): XrayLicensePolicy | undefined {
  return findPolicyByName(policies, name)
}
