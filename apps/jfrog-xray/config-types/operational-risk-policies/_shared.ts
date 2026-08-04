// =============================================================================
// Shared types + helpers for the JFrog Xray Operational Risk Policies config
// type. Pure and network-free so validate.ts, deploy.ts, driftDetect.ts and
// the tests all read a canvas item and build an Xray policy body the same way.
//
// An operational-risk policy is a policy of `type: "operational_risk"`
// against the exact same /xray/api/v2/policies endpoints as security/license
// policies — only the CRITERIA shape differs: either a named minimum risk
// level (`op_risk_min_risk`), or a custom multi-factor rule
// (`op_risk_custom`) built from project-maturity signals. The ACTIONS block
// and the CRUD-by-name plumbing are shared via lib/xrayPolicies.ts.
//
// Criteria fields verified against JFrog's own Terraform provider docs:
//   https://github.com/jfrog/terraform-provider-xray/blob/master/docs/resources/operational_risk_policy.md
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

export const MIN_RISK_LEVELS = ['High', 'Medium', 'Low'] as const

// --- Xray operational-risk-policy wire shapes (criteria is op-risk-specific) --

export interface XrayOpRiskCustom {
  use_and_condition: boolean
  is_eol?: boolean
  release_date_greater_than_months?: number
  newer_versions_greater_than?: number
  release_cadence_per_year_less_than?: number
  commits_less_than?: number
  committers_less_than?: number
  risk?: string
}

export interface XrayOperationalRiskCriteria {
  op_risk_min_risk?: string
  op_risk_custom?: XrayOpRiskCustom
  [extra: string]: unknown
}

export type XrayOperationalRiskRule = XrayPolicyRule<XrayOperationalRiskCriteria>
export type XrayOperationalRiskPolicy = XrayPolicy<XrayOperationalRiskCriteria>
export type { XrayPolicyActions }

// --- Canvas spec extraction ----------------------------------------------------

export interface OperationalRiskPolicySpec extends PolicyActionFields {
  itemLabel: string
  name: string
  description?: string
  ruleName: string
  priority?: number
  riskMode: string
  minRisk: string
  customUseAndCondition: boolean
  customIsEol: boolean
  customReleaseDateMonths?: number
  customNewerVersions?: number
  customReleaseCadence?: number
  customCommitsLessThan?: number
  customCommittersLessThan?: number
  customRisk: string
  criteriaJson: string
  additionalRulesJson: string
}

/** Read every canvas item as an `OperationalRiskPolicySpec`. Tolerates the `items`/`sections` alias. */
export function extractOperationalRiskPolicySpecs(canvas: CanvasSnapshot): OperationalRiskPolicySpec[] {
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
      riskMode: readString(f.risk_mode) || 'min_risk',
      minRisk: readString(f.min_risk) || 'Medium',
      customUseAndCondition: readBool(f.custom_use_and_condition, true),
      customIsEol: readBool(f.custom_is_eol, false),
      customReleaseDateMonths: readOptionalNumber(f.custom_release_date_months),
      customNewerVersions: readOptionalNumber(f.custom_newer_versions),
      customReleaseCadence: readOptionalNumber(f.custom_release_cadence),
      customCommitsLessThan: readOptionalNumber(f.custom_commits_less_than),
      customCommittersLessThan: readOptionalNumber(f.custom_committers_less_than),
      customRisk: readString(f.custom_risk) || 'Medium',
      criteriaJson: typeof f.criteria_json === 'string' ? f.criteria_json : '',
      additionalRulesJson: typeof f.additional_rules_json === 'string' ? f.additional_rules_json : '',
    }
  })
}

export { policyKey }

/** True when at least one custom condition sub-field is actually set (beyond the required use_and_condition flag). */
export function hasCustomCondition(spec: OperationalRiskPolicySpec): boolean {
  return (
    spec.customIsEol ||
    spec.customReleaseDateMonths !== undefined ||
    spec.customNewerVersions !== undefined ||
    spec.customReleaseCadence !== undefined ||
    spec.customCommitsLessThan !== undefined ||
    spec.customCommittersLessThan !== undefined
  )
}

/** Build the primary rule's `criteria` object from the typed fields + the JSON escape valve. */
export function buildCriteria(spec: OperationalRiskPolicySpec): XrayOperationalRiskCriteria {
  const criteria: XrayOperationalRiskCriteria = {}
  if (spec.riskMode === 'custom') {
    const custom: XrayOpRiskCustom = { use_and_condition: spec.customUseAndCondition }
    if (spec.customIsEol) custom.is_eol = true
    if (spec.customReleaseDateMonths !== undefined) custom.release_date_greater_than_months = spec.customReleaseDateMonths
    if (spec.customNewerVersions !== undefined) custom.newer_versions_greater_than = spec.customNewerVersions
    if (spec.customReleaseCadence !== undefined) custom.release_cadence_per_year_less_than = spec.customReleaseCadence
    if (spec.customCommitsLessThan !== undefined) custom.commits_less_than = spec.customCommitsLessThan
    if (spec.customCommittersLessThan !== undefined) custom.committers_less_than = spec.customCommittersLessThan
    custom.risk = spec.customRisk
    criteria.op_risk_custom = custom
  } else {
    criteria.op_risk_min_risk = spec.minRisk
  }

  const extra = parseJsonObject(spec.criteriaJson)
  return extra.ok ? { ...extra.value, ...criteria } : criteria
}

/** Build the primary rule's `actions` object from the shared typed fields + the JSON escape valve. */
export function buildActions(spec: OperationalRiskPolicySpec): XrayPolicyActions {
  return buildPolicyActions(spec)
}

/**
 * Build the primary declared rule (typed fields + JSON escape valves merged in).
 * Falls back to "default-rule" when unset — validate.ts rejects a blank rule
 * name, but deploy must still never send Xray an unnamed rule.
 */
export function buildPrimaryRule(spec: OperationalRiskPolicySpec): XrayOperationalRiskRule {
  const rule: XrayOperationalRiskRule = { name: spec.ruleName || 'default-rule', criteria: buildCriteria(spec), actions: buildActions(spec) }
  if (spec.priority !== undefined) rule.priority = spec.priority
  return rule
}

/** Parse `additional_rules_json` into extra `XrayOperationalRiskRule`s appended after the primary rule. */
export function buildAdditionalRules(spec: OperationalRiskPolicySpec): XrayOperationalRiskRule[] {
  const parsed = parseJsonArray(spec.additionalRulesJson)
  if (!parsed.ok) return []
  const rules: XrayOperationalRiskRule[] = []
  for (const entry of parsed.value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const rec = entry as Record<string, unknown>
    const name = readString(rec.name)
    if (!name) continue
    const criteria = rec.criteria && typeof rec.criteria === 'object' && !Array.isArray(rec.criteria) ? (rec.criteria as XrayOperationalRiskCriteria) : {}
    const actions = rec.actions && typeof rec.actions === 'object' && !Array.isArray(rec.actions) ? (rec.actions as XrayPolicyActions) : {}
    const rule: XrayOperationalRiskRule = { name, criteria, actions }
    const priority = readOptionalNumber(rec.priority)
    if (priority !== undefined) rule.priority = priority
    rules.push(rule)
  }
  return rules
}

/** The full policy body sent on POST (create) / PUT (update). */
export function buildPolicyBody(spec: OperationalRiskPolicySpec): XrayOperationalRiskPolicy {
  const body: XrayOperationalRiskPolicy = {
    name: spec.name,
    type: 'operational_risk',
    rules: [buildPrimaryRule(spec), ...buildAdditionalRules(spec)],
  }
  if (spec.description) body.description = spec.description
  return body
}

/** Find a live policy by name (exact match — Xray policy names are case-sensitive). */
export function findPolicy(policies: XrayOperationalRiskPolicy[], name: string): XrayOperationalRiskPolicy | undefined {
  return findPolicyByName(policies, name)
}
