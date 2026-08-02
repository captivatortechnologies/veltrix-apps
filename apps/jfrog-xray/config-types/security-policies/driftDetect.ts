import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildXrayClient } from '../../lib/xrayApi'
import { POLICIES_PATH, policyPath } from './deploy'
import {
  buildAdditionalRules,
  buildPrimaryRule,
  extractPolicySpecs,
  findPolicy,
  type XraySecurityActions,
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
    live = await client.getJson<XraySecurityPolicy[]>(POLICIES_PATH)
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
      full = await client.getJson<XraySecurityPolicy>(policyPath(spec.name))
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
  diffActions(label, desired.actions, live.actions ?? {}, diffs)
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
  diffBool(`${label}.malicious_package`, desired.malicious_package, live.malicious_package, diffs)
  diffBool(`${label}.applicable_cves_only`, desired.applicable_cves_only, live.applicable_cves_only, diffs)
  diffBool(`${label}.fix_version_dependant`, desired.fix_version_dependant, live.fix_version_dependant, diffs)
}

function diffActions(label: string, desired: XraySecurityActions, live: XraySecurityActions, diffs: DriftDiff[]): void {
  diffBool(`${label}.fail_build`, desired.fail_build, live.fail_build, diffs)
  diffBool(`${label}.block_release_bundle_distribution`, desired.block_release_bundle_distribution, live.block_release_bundle_distribution, diffs)
  diffBool(`${label}.block_release_bundle_promotion`, desired.block_release_bundle_promotion, live.block_release_bundle_promotion, diffs)
  diffBool(`${label}.notify_watch_recipients`, desired.notify_watch_recipients, live.notify_watch_recipients, diffs)
  diffBool(`${label}.notify_deployer`, desired.notify_deployer, live.notify_deployer, diffs)
  diffBool(`${label}.create_ticket_enabled`, desired.create_ticket_enabled, live.create_ticket_enabled, diffs)
  diffBool(`${label}.fail_pull_request`, desired.fail_pull_request, live.fail_pull_request, diffs)

  const desiredBlock = desired.block_download ?? {}
  const liveBlock = live.block_download ?? {}
  diffBool(`${label}.block_download.active`, desiredBlock.active, liveBlock.active, diffs)
  diffBool(`${label}.block_download.unscanned`, desiredBlock.unscanned, liveBlock.unscanned, diffs)
}

/** Compare two optional booleans, treating `undefined` as `false` (Xray omits false-valued flags). */
function diffBool(field: string, desired: boolean | undefined, actual: boolean | undefined, diffs: DriftDiff[]): void {
  const want = desired ?? false
  const have = actual ?? false
  if (want !== have) {
    diffs.push({ field, expected: String(want), actual: String(have), severity: 'warning' })
  }
}
