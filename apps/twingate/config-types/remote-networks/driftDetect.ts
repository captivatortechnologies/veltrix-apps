import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildTwingateClient } from '../../lib/twingateApi'
import { listRemoteNetworks } from './deploy'
import { extractRemoteNetworkSpecs, networkKey } from './_shared'

/**
 * Detect drift between the deployed Remote Network configuration and the live
 * Twingate tenant. Re-finds each declared network by name and diffs
 * location/networkType/isActive; a missing network is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTwingateClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractRemoteNetworkSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listRemoteNetworks(client)
    const byName = new Map(live.filter((n) => n.name).map((n) => [networkKey(n.name as string), n]))

    for (const spec of specs) {
      const label = spec.name
      const found = byName.get(networkKey(spec.name))
      if (!found || !found.id) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      if ((found.location ?? 'OTHER') !== spec.location) {
        diffs.push({ field: `${label}.location`, expected: spec.location, actual: found.location ?? 'not set', severity: 'warning' })
      }
      if ((found.networkType ?? 'REGULAR') !== spec.networkType) {
        diffs.push({
          field: `${label}.network_type`,
          expected: spec.networkType,
          actual: found.networkType ?? 'not set',
          severity: 'warning',
        })
      }
      const liveActive = found.isActive ?? true
      if (liveActive !== spec.isActive) {
        diffs.push({ field: `${label}.is_active`, expected: String(spec.isActive), actual: String(liveActive), severity: 'warning' })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'twingate',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
