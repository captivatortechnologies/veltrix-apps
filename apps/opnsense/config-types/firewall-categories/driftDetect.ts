import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildOpnsenseClient, searchCategories, type LiveCategory } from '../../lib/opnsenseApi'
import { categoryKey, extractCategorySpecs } from './_shared'

/**
 * Detect drift between the deployed category configuration and the live
 * OPNsense box: a missing category is critical drift; a changed color is a
 * warning. Read-only.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildOpnsenseClient(ctx.component.hostname, ctx.component.port, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractCategorySpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await searchCategories(client)
    const byName = new Map<string, LiveCategory>(live.filter((c) => c.name).map((c) => [categoryKey(c.name as string), c]))

    for (const spec of specs) {
      const found = byName.get(categoryKey(spec.name))
      const label = spec.name

      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveColor = String(found.color ?? '')
      if (liveColor !== spec.color) {
        diffs.push({ field: `${label}.color`, expected: spec.color || '(none)', actual: liveColor || '(none)', severity: 'warning' })
      }
    }
  } catch {
    diffs.push({ field: 'opnsense', expected: 'reachable', actual: 'unreachable', severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
