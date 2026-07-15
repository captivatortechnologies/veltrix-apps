import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { listNetworkAppGroups } from './deploy'
import { extractNetworkAppGroupSpecs } from './validate'

/**
 * Detect drift between the deployed network application group configuration and
 * the live tenant. Re-finds each declared group by name and diffs the managed
 * description and member network applications (compared order-insensitively); a
 * missing group is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractNetworkAppGroupSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listNetworkAppGroups(client)
    const byName = new Map(live.filter((g) => g.name).map((g) => [g.name as string, g]))

    for (const spec of specs) {
      const found = byName.get(spec.name)
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveDescription = (typeof found.description === 'string' ? found.description : '').trim()
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${spec.name}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
          severity: 'info',
        })
      }

      // Compare membership order-insensitively — ZIA does not preserve order.
      const expectedApps = [...spec.networkApplications].sort()
      const liveApps = (Array.isArray(found.networkApplications) ? found.networkApplications : [])
        .map((a) => String(a))
        .sort()
      if (expectedApps.join(',') !== liveApps.join(',')) {
        diffs.push({
          field: `${spec.name}.networkApplications`,
          expected: expectedApps.length ? expectedApps.join(', ') : 'not set',
          actual: liveApps.length ? liveApps.join(', ') : 'not set',
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
