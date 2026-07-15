import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { listFirewallRules } from './deploy'
import { extractFirewallRuleSpecs } from './validate'

/**
 * Detect drift between the deployed firewall rule configuration and the live
 * tenant. Re-finds each declared rule by name and diffs the managed first-class
 * scalar fields — order, action and state; a missing rule is critical drift.
 *
 * NOTE: the `rule_json` matching-criteria body is deliberately NOT deep-diffed.
 * ZIA server-normalises those objects heavily (resolving name references to
 * ids, expanding defaults, reordering arrays), so a structural comparison would
 * report noisy false-positive drift on every run. Presence + the first-class
 * scalars are the stable, meaningful signal.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractFirewallRuleSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listFirewallRules(client)
    const byName = new Map(live.filter((r) => r.name).map((r) => [r.name as string, r]))

    for (const spec of specs) {
      const found = byName.get(spec.name)
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const expectedOrder = spec.order ?? 1
      if (found.order !== undefined && found.order !== expectedOrder) {
        diffs.push({
          field: `${spec.name}.order`,
          expected: String(expectedOrder),
          actual: String(found.order),
          severity: 'info',
        })
      }

      const liveAction = typeof found.action === 'string' ? found.action : ''
      if (liveAction && liveAction !== spec.action) {
        diffs.push({
          field: `${spec.name}.action`,
          expected: spec.action,
          actual: liveAction,
          severity: 'warning',
        })
      }

      const liveState = typeof found.state === 'string' ? found.state : ''
      if (liveState && liveState !== spec.state) {
        diffs.push({
          field: `${spec.name}.state`,
          expected: spec.state,
          actual: liveState,
          severity: 'warning',
        })
      }
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
