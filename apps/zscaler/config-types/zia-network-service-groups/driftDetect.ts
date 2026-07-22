import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { attachDriftActor, veltrixActorLogins } from '../lib/zscalerAudit'
import { listServiceGroups } from './deploy'
import { extractServiceGroupSpecs } from './validate'

/** Sorted, de-duplicated member service names for a stable comparison. */
function normalizeServices(names: string[]): string[] {
  return [...new Set(names)].sort((a, b) => a.localeCompare(b))
}

/**
 * Detect drift between the deployed network service group configuration and the
 * live tenant. Re-finds each declared group by name and diffs the managed
 * description and member service set (compared as sorted name lists); a missing
 * group is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  const specs = extractServiceGroupSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listServiceGroups(client)
    const byName = new Map(live.filter((g) => g.name).map((g) => [g.name as string, g]))

    for (const spec of specs) {
      const found = byName.get(spec.name)
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      const before = diffs.length

      const liveDescription = (typeof found.description === 'string' ? found.description : '').trim()
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${spec.name}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
          severity: 'info',
        })
      }

      const expectedServices = normalizeServices(spec.services)
      const liveServices = normalizeServices(
        (found.services ?? [])
          .map((s) => (typeof s.name === 'string' ? s.name : ''))
          .filter((name) => name.length > 0),
      )
      if (expectedServices.join('|') !== liveServices.join('|')) {
        diffs.push({
          field: `${spec.name}.services`,
          expected: expectedServices.join(', ') || 'none',
          actual: liveServices.join(', ') || 'none',
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
