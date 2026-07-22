import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { attachDriftActor, veltrixActorLogins } from '../lib/zscalerAudit'
import { listFileTypeRules } from './deploy'
import { extractFileTypeRuleSpecs } from './validate'

/**
 * Detect drift between the deployed file type rule configuration and the live
 * tenant. Re-finds each declared rule by name and diffs only the managed scalar
 * fields — order, action and state; a missing rule is critical drift.
 *
 * The advanced JSON body (fileTypes[] and object references) is intentionally
 * NOT deep-diffed: it is too noisy and ZIA server-normalizes references (ids,
 * ordering, expanded objects) so a byte comparison would report perpetual drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  const specs = extractFileTypeRuleSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listFileTypeRules(client)
    const byName = new Map(live.filter((r) => r.name).map((r) => [r.name as string, r]))

    for (const spec of specs) {
      const found = byName.get(spec.name)
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      const before = diffs.length

      const expectedOrder = spec.order ?? 1
      if (found.order != null && found.order !== expectedOrder) {
        diffs.push({
          field: `${spec.name}.order`,
          expected: String(expectedOrder),
          actual: String(found.order),
          severity: 'info',
        })
      }

      const liveAction = typeof found.action === 'string' ? found.action.toUpperCase() : ''
      if (liveAction && liveAction !== spec.action) {
        diffs.push({
          field: `${spec.name}.action`,
          expected: spec.action,
          actual: liveAction,
          severity: 'info',
        })
      }

      const liveState = typeof found.state === 'string' ? found.state.toUpperCase() : ''
      if (liveState && liveState !== spec.state) {
        diffs.push({
          field: `${spec.name}.state`,
          expected: spec.state,
          actual: liveState,
          severity: 'info',
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
