import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient } from '../../lib/zscaler'
import { attachDriftActor, veltrixActorLogins } from '../lib/zscalerAudit'
import { listIpSourceGroups } from './deploy'
import { extractIpSourceGroupSpecs } from './validate'

/**
 * Detect drift between the deployed IP source group configuration and the live
 * tenant. Re-finds each declared group by name and diffs the managed
 * description and source IP addresses (compared order-independently); a missing
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

  const specs = extractIpSourceGroupSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listIpSourceGroups(client)
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

      const liveAddresses = Array.isArray(found.ipAddresses) ? found.ipAddresses.map(String) : []
      // Order-independent compare: the set of addresses is what matters, not the
      // order ZIA happens to return them in.
      if ([...spec.ipAddresses].sort().join('\n') !== [...liveAddresses].sort().join('\n')) {
        diffs.push({
          field: `${spec.name}.ipAddresses`,
          expected: spec.ipAddresses.join(', ') || 'not set',
          actual: liveAddresses.join(', ') || 'not set',
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
