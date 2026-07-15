import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { listSslRules } from './deploy'
import { extractSslRuleSpecs } from './validate'

/**
 * Detect drift between the deployed SSL inspection rule configuration and the
 * live tenant. Re-finds each declared rule by name and diffs only the managed
 * scalar fields: presence, `order` and `state`. A missing rule is critical
 * drift.
 *
 * The SSL `action` is an OBJECT that lives inside rule_json, and the rest of the
 * rule_json body is optional, high-cardinality, and ZIA server-normalizes its
 * references (ids, ordering, echoed defaults) — so it is deliberately NOT
 * deep-diffed here; comparing it produces noisy phantom drift. Presence + the
 * two scalar fields ZIA lets us manage first-class (order, state) is the signal
 * worth alerting on.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractSslRuleSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listSslRules(client)
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
