import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, sameSet } from '../../lib/falcon'
import { findFileVantageByName } from '../../lib/filevantageAdapter'
import { attachDriftActor, veltrixActorLogins } from '../lib/crowdstrikeAudit'
import { FILEVANTAGE_POLICY_ENDPOINTS } from './deploy'
import {
  extractPolicySpecs,
  fileVantageHostGroupIds,
  fileVantageRuleGroupIds,
  sameOrder,
} from './validate'

/**
 * Detect drift between the deployed FileVantage policy configuration and the
 * live tenant state. Looks up each declared policy and diffs enablement, host
 * group assignments, ordered rule group assignments, and description.
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

  const specs = extractPolicySpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = await findFileVantageByName(client, FILEVANTAGE_POLICY_ENDPOINTS, spec.name)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // Enablement decides whether the policy monitors anything
      if (live.enabled !== spec.enabled) {
        diffs.push({
          field: `${spec.name}.enabled`,
          expected: spec.enabled,
          actual: live.enabled ?? false,
          severity: 'critical',
        })
      }

      // Host group assignments decide which hosts the policy applies to
      const liveHostGroups = fileVantageHostGroupIds(live)
      if (!sameSet(liveHostGroups, spec.hostGroups)) {
        diffs.push({
          field: `${spec.name}.hostGroups`,
          expected: spec.hostGroups.join(', ') || 'none',
          actual: liveHostGroups.join(', ') || 'none',
          severity: 'warning',
        })
      }

      // Rule group assignments decide which files are monitored — ORDERED,
      // because the order sets precedence
      const liveRuleGroups = fileVantageRuleGroupIds(live)
      if (!sameOrder(liveRuleGroups, spec.ruleGroups)) {
        diffs.push({
          field: `${spec.name}.ruleGroups`,
          expected: spec.ruleGroups.join(' > ') || 'none',
          actual: liveRuleGroups.join(' > ') || 'none',
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
