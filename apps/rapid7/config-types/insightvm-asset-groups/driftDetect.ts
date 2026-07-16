import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient } from '../../lib/insightvm'
import { listAssetGroups } from './deploy'
import { assetGroupKey, extractAssetGroupSpecs, type LiveAssetGroup } from './validate'

/**
 * Detect drift between the deployed asset group configuration and the live
 * console. Re-finds each declared group by name and diffs the managed fields
 * (description, type); a missing group is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractAssetGroupSpecs(ctx.deployedConfig).filter((s) => s.name && s.type)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listAssetGroups(client)
    const byKey = new Map<string, LiveAssetGroup>(
      live.filter((g) => g.name).map((g) => [assetGroupKey({ name: g.name as string }), g]),
    )

    for (const spec of specs) {
      const found = byKey.get(assetGroupKey(spec))
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if ((found.description ?? '') !== spec.description) {
        diffs.push({
          field: `${spec.name}.description`,
          expected: spec.description || 'not set',
          actual: found.description ?? 'not set',
          severity: 'info',
        })
      }
      if (found.type && found.type !== spec.type) {
        diffs.push({ field: `${spec.name}.type`, expected: spec.type, actual: found.type, severity: 'warning' })
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
