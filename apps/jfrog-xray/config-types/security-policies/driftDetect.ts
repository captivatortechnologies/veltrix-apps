import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildXrayClient } from '../../lib/xrayApi'
import { diffPolicyActions, getPolicyByName, listPolicies } from '../../lib/xrayPolicies'
import {
  buildAdditionalRules,
  buildPrimaryRule,
  extractPolicySpecs,
  findPolicy,
  type XraySecurityCriteria,
  type XraySecurityPolicy,
  type XraySecurityRule,
} from './_shared'

/**
 * Detect drift between the last-deployed security-policy configuration and the
 * live Xray tenant. Re-reads each declared policy by name (`GET
 * /api/v2/policies/{name}`) and compares:
 *   - existence (a missing policy is CRITICAL drift)
 *   - description
 *   - the total rule count (declared primary + additional rules vs live)
 *   - the primary rule's severity gate and the actions this app manages
 * Best-effort and read-only: any transport failure reports no drift rather than
 * a false positive (matches the platform's drift-detection convention for an
 * unreachable target — a healthCheck failure already surfaces reachability).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildXrayClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractPolicySpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs }

  let live: XraySecurityPolicy[]
  try {
    live = await listPolicies<XraySecurityCriteria>(client)
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

    let full: XraySecurityPolicy
    try {
      full = await getPolicyByName<XraySecurityCriteria>(client, spec.name)
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
function diffRule(label: string, desired: XraySecurityRule, live: XraySecurityRule | undefined, diffs: DriftDiff[]): void {
  if (!live) {
    diffs.push({ field: `${label}.${desired.name}`, expected: 'exists', actual: 'missing', severity: 'critical' })
    return
  }
  diffCriteria(label, desired.criteria, live.criteria ?? {}, diffs)
  diffPolicyActions(label, desired.actions, live.actions ?? {}, (field, expected, actual, severity) => {
    diffs.push({ field, expected, actual, severity })
  })
}

function diffCriteria(label: string, desired: XraySecurityCriteria, live: XraySecurityCriteria, diffs: DriftDiff[]): void {
  if (desired.min_severity !== undefined) {
    if ((live.min_severity ?? '') !== desired.min_severity) {
      diffs.push({ field: `${label}.min_severity`, expected: desired.min_severity, actual: live.min_severity ?? '(none)', severity: 'warning' })
    }
  }
  if (desired.cvss_range) {
    const liveRange = live.cvss_range
    if (!liveRange || liveRange.from !== desired.cvss_range.from || liveRange.to !== desired.cvss_range.to) {
      diffs.push({
        field: `${label}.cvss_range`,
        expected: `${desired.cvss_range.from}–${desired.cvss_range.to}`,
        actual: liveRange ? `${liveRange.from}–${liveRange.to}` : '(none)',
        severity: 'warning',
      })
    }
  }
  diffCriteriaBool(`${label}.malicious_package`, desired.malicious_package, live.malicious_package, diffs)
  diffCriteriaBool(`${label}.applicable_cves_only`, desired.applicable_cves_only, live.applicable_cves_only, diffs)
  diffCriteriaBool(`${label}.fix_version_dependant`, desired.fix_version_dependant, live.fix_version_dependant, diffs)
}

/** Compare two optional booleans, treating `undefined` as `false` (Xray omits false-valued flags). */
function diffCriteriaBool(field: string, desired: boolean | undefined, actual: boolean | undefined, diffs: DriftDiff[]): void {
  const want = desired ?? false
  const have = actual ?? false
  if (want !== have) {
    diffs.push({ field, expected: String(want), actual: String(have), severity: 'warning' })
  }
}
