import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient } from '../../lib/insightvm'
import { listPools } from './deploy'
import { extractPoolSpecs, poolKey, type LivePool } from './validate'

/**
 * Detect drift between the deployed scan engine pool configuration and the live
 * console. Re-finds each declared pool by its name; a missing pool is critical
 * drift, and a change in the number of member engines is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractPoolSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listPools(client)
    const byKey = new Map<string, LivePool>(
      live.filter((p) => p.name).map((p) => [poolKey({ name: p.name as string }), p]),
    )

    for (const spec of specs) {
      const found = byKey.get(poolKey(spec))
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      const liveCount = Array.isArray(found.engines) ? found.engines.length : 0
      if (liveCount !== spec.engines.length) {
        diffs.push({
          field: `${spec.name}.engines`,
          expected: `${spec.engines.length} engine(s)`,
          actual: `${liveCount} engine(s)`,
          severity: 'warning',
        })
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
