import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, sameSet } from '../../lib/falcon'
import { attachDriftActor, veltrixActorLogins } from '../lib/crowdstrikeAudit'
import { findKacPolicy, liveEnabled, liveHostGroups } from './deploy'
import { deepEqual, extractKacPolicySpecs, parseRuleGroups } from './validate'

/**
 * Detect drift between the deployed KAC policy configuration and the live tenant
 * state. Diffs the scalar fields the policy body carries (enablement, description,
 * host group assignment) and deep-compares the declared rule_groups against the
 * live policy's rule_groups. Until nested rule-group deployment lands (Phase 4) a
 * rule_groups diff reflects the declared-vs-live gap rather than manual drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  // Connection identity our own deploys are recorded under — excluded so
  // attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  const specs = extractKacPolicySpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = await findKacPolicy(client, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // Enablement decides whether the policy admits anything
      const enabled = liveEnabled(live)
      if (enabled !== spec.enabled) {
        diffs.push({
          field: `${spec.name}.enabled`,
          expected: spec.enabled,
          actual: enabled,
          severity: 'critical',
        })
      }

      // Host group assignments decide which clusters the policy applies to
      const liveGroups = liveHostGroups(live)
      if (!sameSet(liveGroups, spec.hostGroups)) {
        diffs.push({
          field: `${spec.name}.hostGroups`,
          expected: spec.hostGroups.join(', ') || 'none',
          actual: liveGroups.join(', ') || 'none',
          severity: 'warning',
        })
      }

      // Declared rule groups vs live rule groups (structural deep-equal)
      const { ruleGroups } = parseRuleGroups(spec.ruleGroupsRaw)
      const liveRuleGroups = Array.isArray(live.rule_groups) ? live.rule_groups : []
      if (!deepEqual(ruleGroups, liveRuleGroups)) {
        diffs.push({
          field: `${spec.name}.ruleGroups`,
          expected: `${ruleGroups.length} rule group(s)`,
          actual: `${liveRuleGroups.length} rule group(s)`,
          severity: 'warning',
        })
      }

      const liveDescription = (live.description ?? '').trim()
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${spec.name}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
          severity: 'info',
        })
      }

      // Attribute every diff this policy produced to Falcon's recorded last
      // modifier (once) — no-op when nothing drifted or the change was ours.
      attachDriftActor(diffs.slice(before), live, { excludeActorLogins })
    } catch (error) {
      diffs.push({
        field: spec.name,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
