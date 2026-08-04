import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildTwingateClient } from '../../lib/twingateApi'
import { listConnectors, listRemoteNetworks } from './deploy'
import { byName, connectorKey, extractConnectorSpecs } from './_shared'

/**
 * Detect drift between the deployed Connector configuration and the live
 * Twingate tenant. Re-finds each declared connector by name and diffs its
 * Remote Network (immutable — a mismatch is critical, since it cannot be
 * corrected via `connectorUpdate`) and `status_updates_enabled`; a missing
 * connector is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildTwingateClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractConnectorSpecs(ctx.deployedConfig).filter((s) => s.name && s.remoteNetworkName)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listConnectors(client)
    const byNameMap = new Map(live.filter((c) => c.name).map((c) => [connectorKey(c.name as string), c]))
    const networksByName = byName(await listRemoteNetworks(client))

    for (const spec of specs) {
      const label = spec.name
      const found = byNameMap.get(connectorKey(spec.name))
      if (!found || !found.id) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const declaredNetwork = networksByName.get(connectorKey(spec.remoteNetworkName))
      if (!declaredNetwork?.id) {
        diffs.push({ field: `${label}.remote_network_name`, expected: spec.remoteNetworkName, actual: 'not found in Twingate', severity: 'critical' })
      } else if ((found.remoteNetwork?.id ?? '') !== declaredNetwork.id) {
        diffs.push({ field: `${label}.remote_network_name`, expected: spec.remoteNetworkName, actual: 'attached to a different Remote Network', severity: 'critical' })
      }

      const liveEnabled = found.hasStatusNotificationsEnabled ?? true
      if (liveEnabled !== spec.statusUpdatesEnabled) {
        diffs.push({
          field: `${label}.status_updates_enabled`,
          expected: String(spec.statusUpdatesEnabled),
          actual: String(liveEnabled),
          severity: 'warning',
        })
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
