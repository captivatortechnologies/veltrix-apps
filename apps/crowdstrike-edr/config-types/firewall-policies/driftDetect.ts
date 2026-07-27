import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, sameSet } from '../../lib/falcon'
import { currentGroupIds } from '../../lib/policyAdapter'
import { attachDriftActor, veltrixActorLogins } from '../lib/crowdstrikeAudit'
import { findFirewallPolicy, getPolicyContainer } from './deploy'
import { extractFirewallPolicySpecs } from './validate'

/**
 * Detect drift between the deployed firewall policy configuration and the live
 * tenant state. Diffs the /policy shell (enablement, host groups, description)
 * and the fwmgr container (ordered rule-group assignment, default in/out
 * actions, enforce, test mode, local logging).
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

  const specs = extractFirewallPolicySpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    const before = diffs.length
    try {
      const live = await findFirewallPolicy(client, spec.name, spec.platform)

      if (!live) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // Enablement decides whether the policy protects anything
      if (live.enabled !== spec.enabled) {
        diffs.push({
          field: `${spec.name}.enabled`,
          expected: spec.enabled,
          actual: live.enabled ?? false,
          severity: 'critical',
        })
      }

      // Host group assignments decide which hosts the policy applies to
      const liveGroups = currentGroupIds(live)
      if (!sameSet(liveGroups, spec.hostGroups)) {
        diffs.push({
          field: `${spec.name}.hostGroups`,
          expected: spec.hostGroups.join(', ') || 'none',
          actual: liveGroups.join(', ') || 'none',
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

      // Container settings live on fwmgr, not the shell
      if (live.id) {
        const container = await getPolicyContainer(client, live.id)
        const liveRuleGroups = container?.rule_group_ids ?? []
        // Rule-group order is precedence, so compare as an ordered list
        if (!orderedEqual(liveRuleGroups, spec.ruleGroups)) {
          diffs.push({
            field: `${spec.name}.ruleGroups`,
            expected: spec.ruleGroups.join(', ') || 'none',
            actual: liveRuleGroups.join(', ') || 'none',
            severity: 'warning',
          })
        }
        if ((container?.default_inbound ?? '') !== spec.defaultInbound) {
          diffs.push({
            field: `${spec.name}.defaultInbound`,
            expected: spec.defaultInbound,
            actual: container?.default_inbound ?? 'unknown',
            severity: 'warning',
          })
        }
        if ((container?.default_outbound ?? '') !== spec.defaultOutbound) {
          diffs.push({
            field: `${spec.name}.defaultOutbound`,
            expected: spec.defaultOutbound,
            actual: container?.default_outbound ?? 'unknown',
            severity: 'warning',
          })
        }
        if ((container?.enforce ?? false) !== spec.enforce) {
          diffs.push({
            field: `${spec.name}.enforce`,
            expected: spec.enforce,
            actual: container?.enforce ?? false,
            severity: 'warning',
          })
        }
        if ((container?.test_mode ?? false) !== spec.testMode) {
          diffs.push({
            field: `${spec.name}.testMode`,
            expected: spec.testMode,
            actual: container?.test_mode ?? false,
            severity: 'info',
          })
        }
        if ((container?.local_logging ?? false) !== spec.localLogging) {
          diffs.push({
            field: `${spec.name}.localLogging`,
            expected: spec.localLogging,
            actual: container?.local_logging ?? false,
            severity: 'info',
          })
        }
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

/** Ordered equality of two id lists — rule-group precedence order is significant. */
function orderedEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((item, index) => item === b[index])
}
