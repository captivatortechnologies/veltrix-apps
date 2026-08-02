import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildXrayClient } from '../../lib/xrayApi'
import { diffPolicyActions, getPolicyByName, listPolicies } from '../../lib/xrayPolicies'
import {
  buildAdditionalRules,
  buildPrimaryRule,
  extractLicensePolicySpecs,
  findPolicy,
  type XrayLicenseCriteria,
  type XrayLicensePolicy,
  type XrayLicenseRule,
} from './_shared'

/**
 * Detect drift between the last-deployed license-policy configuration and the
 * live Xray tenant. Re-reads each declared policy by name (`GET
 * /api/v2/policies/{name}`) and compares:
 *   - existence (a missing policy is CRITICAL drift)
 *   - description
 *   - the total rule count (declared primary + additional rules vs live)
 *   - the primary rule's license criteria and the actions this app manages
 * Best-effort and read-only: any transport failure reports no drift rather than
 * a false positive.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildXrayClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractLicensePolicySpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs }

  let live: XrayLicensePolicy[]
  try {
    live = await listPolicies<XrayLicenseCriteria>(client)
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

    let full: XrayLicensePolicy
    try {
      full = await getPolicyByName<XrayLicenseCriteria>(client, spec.name)
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
function diffRule(label: string, desired: XrayLicenseRule, live: XrayLicenseRule | undefined, diffs: DriftDiff[]): void {
  if (!live) {
    diffs.push({ field: `${label}.${desired.name}`, expected: 'exists', actual: 'missing', severity: 'critical' })
    return
  }
  diffCriteria(label, desired.criteria, live.criteria ?? {}, diffs)
  diffPolicyActions(label, desired.actions, live.actions ?? {}, (field, expected, actual, severity) => {
    diffs.push({ field, expected, actual, severity })
  })
}

function diffCriteria(label: string, desired: XrayLicenseCriteria, live: XrayLicenseCriteria, diffs: DriftDiff[]): void {
  const desiredAllowed = [...(desired.allowed_licenses ?? [])].sort()
  const liveAllowed = [...(live.allowed_licenses ?? [])].sort()
  if (JSON.stringify(desiredAllowed) !== JSON.stringify(liveAllowed)) {
    diffs.push({
      field: `${label}.allowed_licenses`,
      expected: desiredAllowed.join(', ') || '(none)',
      actual: liveAllowed.join(', ') || '(none)',
      severity: 'warning',
    })
  }

  const desiredBanned = [...(desired.banned_licenses ?? [])].sort()
  const liveBanned = [...(live.banned_licenses ?? [])].sort()
  if (JSON.stringify(desiredBanned) !== JSON.stringify(liveBanned)) {
    diffs.push({
      field: `${label}.banned_licenses`,
      expected: desiredBanned.join(', ') || '(none)',
      actual: liveBanned.join(', ') || '(none)',
      severity: 'warning',
    })
  }

  diffCriteriaBool(`${label}.allow_unknown`, desired.allow_unknown, live.allow_unknown, diffs)
  diffCriteriaBool(`${label}.multi_license_permissive`, desired.multi_license_permissive, live.multi_license_permissive, diffs)
}

/** Compare two optional booleans, treating `undefined` as `false` (Xray omits false-valued flags). */
function diffCriteriaBool(field: string, desired: boolean | undefined, actual: boolean | undefined, diffs: DriftDiff[]): void {
  const want = desired ?? false
  const have = actual ?? false
  if (want !== have) {
    diffs.push({ field, expected: String(want), actual: String(have), severity: 'warning' })
  }
}
