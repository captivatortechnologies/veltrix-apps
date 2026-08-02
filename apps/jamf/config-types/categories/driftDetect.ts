import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient } from '../../lib/jamfApi'
import { listCategories } from './deploy'
import { categoryKey, extractCategorySpecs, indexCategoriesByName } from './validate'

/**
 * Detect drift between the deployed category configuration and the live Jamf
 * Pro tenant. Re-finds each declared category by name and diffs `priority`; a
 * missing category is critical drift, a changed priority is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractCategorySpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listCategories(client, ctx.settings)
    const byName = indexCategoriesByName(live)

    for (const spec of specs) {
      const label = spec.name
      const found = byName.get(categoryKey(spec.name))
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      const livePriority = found.priority ?? 0
      if (livePriority !== spec.priority) {
        diffs.push({ field: `${label}.priority`, expected: spec.priority, actual: livePriority, severity: 'warning' })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'jamf',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
