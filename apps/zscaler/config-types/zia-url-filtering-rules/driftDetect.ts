import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { attachDriftActor, veltrixActorLogins } from '../lib/zscalerAudit'
import { listUrlFilteringRules } from './deploy'
import { extractUrlFilteringRuleSpecs, resolveOrder } from './validate'

/**
 * Detect drift between the deployed URL filtering rule configuration and the live
 * tenant. Re-finds each declared rule by name and diffs only the managed scalar
 * fields: presence (missing = critical), order, action and state.
 *
 * The rule_json escape hatch is intentionally NOT deep-diffed: it holds arbitrary
 * advanced criteria and object references (locations, groups, labels, …) that ZIA
 * normalises and enriches server-side (assigning ids, echoing display names, re-
 * ordering arrays), so a structural diff would be dominated by false positives.
 * Presence + the first-class scalars are the reliable drift signal.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  const specs = extractUrlFilteringRuleSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listUrlFilteringRules(client)
    const byName = new Map(live.filter((r) => r.name).map((r) => [r.name as string, r]))

    for (const spec of specs) {
      const found = byName.get(spec.name)
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      const before = diffs.length

      const expectedOrder = resolveOrder(spec)
      if (typeof found.order === 'number' && found.order !== expectedOrder) {
        diffs.push({
          field: `${spec.name}.order`,
          expected: String(expectedOrder),
          actual: String(found.order),
          severity: 'info',
        })
      }

      const liveAction = typeof found.action === 'string' ? found.action : ''
      if (liveAction !== spec.action) {
        diffs.push({
          field: `${spec.name}.action`,
          expected: spec.action,
          actual: liveAction || 'not set',
          severity: 'warning',
        })
      }

      const liveState = typeof found.state === 'string' ? found.state : ''
      if (liveState !== spec.state) {
        diffs.push({
          field: `${spec.name}.state`,
          expected: spec.state,
          actual: liveState || 'not set',
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
