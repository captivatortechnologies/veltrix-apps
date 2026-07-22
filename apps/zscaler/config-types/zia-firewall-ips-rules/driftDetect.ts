import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { attachDriftActor, veltrixActorLogins } from '../lib/zscalerAudit'
import { listIpsRules } from './deploy'
import { extractIpsRuleSpecs, parsePositiveInt, DEFAULT_ORDER } from './validate'

/**
 * Detect drift between the deployed firewall IPS rule configuration and the live
 * tenant. Re-finds each declared rule by name and diffs the managed scalar
 * fields (order, action, state); a missing rule is critical drift.
 *
 * NOTE: we deliberately do NOT deep-diff the advanced rule_json body. Those
 * criteria are numerous and get server-normalized (name references expand to
 * {id,name} objects, defaults are filled in, arrays reordered), so a deep diff
 * would be perpetually noisy. Presence plus the managed scalars are the
 * meaningful drift signals.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  const specs = extractIpsRuleSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listIpsRules(client)
    const byName = new Map(live.filter((r) => r.name).map((r) => [r.name as string, r]))

    for (const spec of specs) {
      const found = byName.get(spec.name)
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      const before = diffs.length

      // order — rule precedence
      const expectedOrder = parsePositiveInt(spec.order) ?? DEFAULT_ORDER
      if (typeof found.order === 'number' && found.order !== expectedOrder) {
        diffs.push({
          field: `${spec.name}.order`,
          expected: expectedOrder,
          actual: found.order,
          severity: 'info',
        })
      }

      // action — behavioural, so a mismatch is warning-level
      const liveAction = typeof found.action === 'string' ? found.action.trim().toUpperCase() : ''
      if (liveAction && liveAction !== spec.action) {
        diffs.push({
          field: `${spec.name}.action`,
          expected: spec.action,
          actual: liveAction,
          severity: 'warning',
        })
      }

      // state — enabled/disabled
      const liveState = typeof found.state === 'string' ? found.state.trim().toUpperCase() : ''
      if (liveState && liveState !== spec.state) {
        diffs.push({
          field: `${spec.name}.state`,
          expected: spec.state,
          actual: liveState,
          severity: 'warning',
        })
      }
      attachDriftActor(diffs.slice(before), found, { excludeActorLogins })
    }
  } catch (error) {
    diffs.push({
      field: 'zia',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
