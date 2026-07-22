import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { attachDriftActor, veltrixActorLogins } from '../lib/zscalerAudit'
import { listDestinationGroups } from './deploy'
import { extractDestinationGroupSpecs } from './validate'

/**
 * Detect drift between the deployed IP destination group configuration and the
 * live tenant. Re-finds each declared group by name and diffs the managed
 * fields (description, type and the set of addresses); a missing group is
 * critical drift. Addresses are compared as an order-insensitive set, since ZIA
 * may re-order the array it returns.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  const specs = extractDestinationGroupSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listDestinationGroups(client)
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

      const liveType = typeof found.type === 'string' ? found.type : ''
      if (spec.type !== liveType) {
        diffs.push({
          field: `${spec.name}.type`,
          expected: spec.type || 'not set',
          actual: liveType || 'not set',
          severity: 'warning',
        })
      }

      const liveAddresses = Array.isArray(found.addresses) ? found.addresses.map(String) : []
      if (!sameSet(spec.addresses, liveAddresses)) {
        diffs.push({
          field: `${spec.name}.addresses`,
          expected: spec.addresses.join(', ') || 'none',
          actual: liveAddresses.join(', ') || 'none',
          severity: 'warning',
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

/** Compare two string arrays as order-insensitive sets. */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  return sortedA.every((value, index) => value === sortedB[index])
}
