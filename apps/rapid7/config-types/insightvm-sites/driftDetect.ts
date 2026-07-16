import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildInsightVMClient } from '../../lib/insightvm'
import { listSites } from './deploy'
import { extractSiteSpecs, siteKey, type LiveSite } from './validate'

/**
 * Detect drift between the deployed site configuration and the live console.
 * Re-finds each declared site by its name and diffs the managed top-level fields
 * (description, importance); a missing site is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildInsightVMClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractSiteSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listSites(client)
    const byKey = new Map<string, LiveSite>(
      live.filter((s) => s.name).map((s) => [siteKey({ name: s.name as string }), s]),
    )

    for (const spec of specs) {
      const found = byKey.get(siteKey(spec))
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if ((found.description ?? '') !== spec.description) {
        diffs.push({ field: `${spec.name}.description`, expected: spec.description || '(empty)', actual: found.description ?? 'not set', severity: 'info' })
      }
      if ((found.importance ?? '') !== spec.importance) {
        diffs.push({ field: `${spec.name}.importance`, expected: spec.importance, actual: found.importance ?? 'not set', severity: 'warning' })
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
