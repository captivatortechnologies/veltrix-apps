import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { listDnsRules } from './deploy'
import { extractDnsRuleSpecs } from './validate'

/**
 * Detect drift between the deployed DNS rule configuration and the live tenant.
 * Re-finds each declared rule by name and diffs only the managed scalar fields:
 * presence, `order`, `action` and `state`. A missing rule is critical drift.
 *
 * The advanced rule_json body is deliberately NOT deep-diffed: it is optional,
 * high-cardinality, and ZIA server-normalizes references (ids, ordering, echoed
 * defaults), so comparing it produces noisy phantom drift. Presence + the three
 * security-relevant scalars is the signal worth alerting on.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractDnsRuleSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listDnsRules(client)
    const byName = new Map(live.filter((r) => r.name).map((r) => [r.name as string, r]))

    for (const spec of specs) {
      const found = byName.get(spec.name)
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // order — the deployed value defaults to 1 the same way deploy does.
      const expectedOrder =
        spec.order !== undefined && Number.isInteger(spec.order) && spec.order > 0 ? spec.order : 1
      if (typeof found.order === 'number' && found.order !== expectedOrder) {
        diffs.push({
          field: `${spec.name}.order`,
          expected: String(expectedOrder),
          actual: String(found.order),
          severity: 'info',
        })
      }

      // action — a security-relevant change (allow vs block vs redirect).
      const liveAction = typeof found.action === 'string' ? found.action : ''
      if (liveAction && liveAction !== spec.action) {
        diffs.push({
          field: `${spec.name}.action`,
          expected: spec.action,
          actual: liveAction,
          severity: 'warning',
        })
      }

      // state — enabled vs disabled.
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
