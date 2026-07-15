import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { listUrlCategories } from './deploy'
import { extractUrlCategorySpecs } from './validate'

/**
 * Detect drift between the deployed custom URL category configuration and the
 * live tenant. Re-finds each declared category by configuredName and diffs the
 * managed description and URL set (compared order-independently); a missing
 * category is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractUrlCategorySpecs(ctx.deployedConfig).filter((s) => s.configuredName)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listUrlCategories(client)
    const byName = new Map(live.filter((c) => c.configuredName).map((c) => [c.configuredName as string, c]))

    for (const spec of specs) {
      const found = byName.get(spec.configuredName)
      if (!found) {
        diffs.push({ field: spec.configuredName, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveDescription = (typeof found.description === 'string' ? found.description : '').trim()
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${spec.configuredName}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
          severity: 'info',
        })
      }

      const liveUrls = Array.isArray(found.urls) ? found.urls.map(String) : []
      // Order-independent compare: the set of URLs is what matters, not the
      // order ZIA happens to return them in.
      if ([...spec.urls].sort().join('\n') !== [...liveUrls].sort().join('\n')) {
        diffs.push({
          field: `${spec.configuredName}.urls`,
          expected: spec.urls.join(', ') || 'not set',
          actual: liveUrls.join(', ') || 'not set',
          severity: 'info',
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
