import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient } from '../../lib/insightvm'
import { listOverrides } from './deploy'
import { extractOverrideSpecs, overrideKey, overrideLabel, liveOverrideKey } from './validate'

/**
 * Detect drift between the deployed policy-override configuration and the live
 * console. Overrides are CREATE/skip only with no mutable managed fields, so
 * drift is presence only: each declared override must still exist by its
 * natural key, and a missing one (recalled or expired) is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractOverrideSpecs(ctx.deployedConfig).filter((s) => s.ruleId !== undefined && s.newResult)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listOverrides(client)
    const keys = new Set<string>()
    for (const o of live) {
      const key = liveOverrideKey(o)
      if (key) keys.add(key)
    }

    for (const spec of specs) {
      const key = overrideKey({ ruleId: spec.ruleId as number, scopeType: spec.scopeType, assetId: spec.assetId })
      if (!keys.has(key)) {
        diffs.push({ field: overrideLabel(spec), expected: 'exists', actual: 'missing', severity: 'critical' })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'insightvm',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
