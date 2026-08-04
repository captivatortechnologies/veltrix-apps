import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildXrayClient } from '../../lib/xrayApi'
import { diffPolicyActions, getPolicyByName, listPolicies } from '../../lib/xrayPolicies'
import {
  buildAdditionalRules,
  buildPrimaryRule,
  extractOperationalRiskPolicySpecs,
  findPolicy,
  type XrayOperationalRiskCriteria,
  type XrayOperationalRiskPolicy,
  type XrayOperationalRiskRule,
} from './_shared'

/**
 * Detect drift between the last-deployed operational-risk-policy configuration
 * and the live Xray tenant. Re-reads each declared policy by name (`GET
 * /api/v2/policies/{name}`) and compares:
 *   - existence (a missing policy is CRITICAL drift)
 *   - description
 *   - the total rule count (declared primary + additional rules vs live)
 *   - the primary rule's risk criteria (named minimum risk, or every custom
 *     condition sub-field) and the actions this app manages
 * Best-effort and read-only: any transport failure reports no drift rather than
 * a false positive.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildXrayClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractOperationalRiskPolicySpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs }

  let live: XrayOperationalRiskPolicy[]
  try {
    live = await listPolicies<XrayOperationalRiskCriteria>(client)
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const spec of specs) {
    const label = spec.name
    const summary = findPolicy(live, spec.name)
    if (!summary) {
      diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    let full: XrayOperationalRiskPolicy
    try {
      full = await getPolicyByName<XrayOperationalRiskCriteria>(client, spec.name)
    } catch {
      continue
    }

    if (spec.description !== undefined) {
      const liveDescription = full.description ?? ''
      if (spec.description !== liveDescription) {
        diffs.push({ field: `${label}.description`, expected: spec.description, actual: liveDescription || '(none)', severity: 'warning' })
      }
    }

    const desiredRules = [buildPrimaryRule(spec), ...buildAdditionalRules(spec)]
    const liveRules = Array.isArray(full.rules) ? full.rules : []
    if (desiredRules.length !== liveRules.length) {
      diffs.push({
        field: `${label}.rules`,
        expected: `${desiredRules.length} rule(s)`,
        actual: `${liveRules.length} rule(s)`,
        severity: 'warning',
      })
    }

    const livePrimary = liveRules.find((r) => r?.name === spec.ruleName) ?? liveRules[0]
    diffRule(label, desiredRules[0], livePrimary, diffs)
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Compare the fields this app manages on the primary rule. A missing live rule is its own diff. */
function diffRule(label: string, desired: XrayOperationalRiskRule, live: XrayOperationalRiskRule | undefined, diffs: DriftDiff[]): void {
  if (!live) {
    diffs.push({ field: `${label}.${desired.name}`, expected: 'exists', actual: 'missing', severity: 'critical' })
    return
  }
  diffCriteria(label, desired.criteria, live.criteria ?? {}, diffs)
  diffPolicyActions(label, desired.actions, live.actions ?? {}, (field, expected, actual, severity) => {
    diffs.push({ field, expected, actual, severity })
  })
}

function diffCriteria(label: string, desired: XrayOperationalRiskCriteria, live: XrayOperationalRiskCriteria, diffs: DriftDiff[]): void {
  if (desired.op_risk_min_risk !== undefined) {
    if ((live.op_risk_min_risk ?? '') !== desired.op_risk_min_risk) {
      diffs.push({
        field: `${label}.op_risk_min_risk`,
        expected: desired.op_risk_min_risk,
        actual: live.op_risk_min_risk ?? '(none)',
        severity: 'warning',
      })
    }
  }

  if (desired.op_risk_custom) {
    const d = desired.op_risk_custom
    const l = live.op_risk_custom ?? ({} as typeof d)
    const fields: Array<keyof typeof d> = [
      'use_and_condition',
      'is_eol',
      'release_date_greater_than_months',
      'newer_versions_greater_than',
      'release_cadence_per_year_less_than',
      'commits_less_than',
      'committers_less_than',
      'risk',
    ]
    for (const key of fields) {
      const dv = d[key]
      const lv = l[key]
      if (String(dv ?? '') !== String(lv ?? '')) {
        diffs.push({ field: `${label}.op_risk_custom.${key}`, expected: String(dv ?? '(none)'), actual: String(lv ?? '(none)'), severity: 'warning' })
      }
    }
  }
}
