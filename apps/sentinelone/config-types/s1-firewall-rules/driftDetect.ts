import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildS1Client } from '../../lib/s1'
import { attachDriftActor, veltrixActorLogins } from '../../lib/s1ActivityLog'
import { listFirewallRules } from './deploy'
import { extractFirewallRuleSpecs, ruleKey, type LiveFirewallRule } from './validate'

/**
 * Detect drift between the deployed Firewall Control configuration and the live
 * scope. Re-finds each declared rule by name and diffs the managed fields; a
 * missing rule is critical drift, an action/status change is a warning, and
 * other field changes are informational.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildS1Client(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built
  if (!client.hasScope) return { hasDrift: false, diffs: [] }

  const specs = extractFirewallRuleSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listFirewallRules(client)
    const byKey = new Map<string, LiveFirewallRule>(live.filter((r) => r.name).map((r) => [ruleKey(r.name as string), r]))

    const veltrixLogins = veltrixActorLogins(ctx.credential)
    const attributions: Array<Promise<void>> = []

    for (const spec of specs) {
      const label = spec.name
      const before = diffs.length
      const found = byKey.get(ruleKey(spec.name))
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
      } else {
        if ((found.action ?? '') !== spec.action) {
          diffs.push({ field: `${label}.action`, expected: spec.action, actual: found.action ?? 'not set', severity: 'warning' })
        }
        if ((found.status ?? '') !== spec.status) {
          diffs.push({ field: `${label}.status`, expected: spec.status, actual: found.status ?? 'not set', severity: 'warning' })
        }
        if ((found.direction ?? '') !== spec.direction) {
          diffs.push({ field: `${label}.direction`, expected: spec.direction, actual: found.direction ?? 'not set', severity: 'info' })
        }
        const liveDescription = (typeof found.description === 'string' ? found.description : '').trim()
        if ((spec.description ?? '') !== liveDescription) {
          diffs.push({
            field: `${label}.description`,
            expected: spec.description ?? 'not set',
            actual: liveDescription || 'not set',
            severity: 'info',
          })
        }
      }

      const objectDiffs = diffs.slice(before)
      if (objectDiffs.length > 0) {
        attributions.push(
          attachDriftActor(client, objectDiffs, {
            targetId: found?.id,
            targetName: spec.name,
            excludeActorLogins: veltrixLogins,
          }),
        )
      }
    }
    await Promise.all(attributions)
  } catch (error) {
    diffs.push({
      field: 'sentinelone',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
