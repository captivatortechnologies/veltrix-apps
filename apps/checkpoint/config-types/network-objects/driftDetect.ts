import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCheckpointClient } from '../../lib/checkpointApi'
import { liveTagNames, sameStringSet } from '../lib/checkpointShared'
import { listAllNetworks } from './deploy'
import { extractNetworkSpecs, networkKey, type LiveNetwork } from './validate'

/**
 * Detect drift between the deployed network-object configuration and the
 * live management database. Re-finds each declared network by name
 * (show-networks) and diffs the managed fields: a missing network is
 * critical drift; a changed subnet, comment, color or tag set is a warning
 * (subnet changes are critical — they change what traffic the object
 * matches). Read-only — logs out without publishing or discarding.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCheckpointClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractNetworkSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const login = await client.login()
  if (login.error) return { hasDrift: false, diffs: [] }

  try {
    const live = await listAllNetworks(client)
    const byName = new Map<string, LiveNetwork>(live.filter((n) => n.name).map((n) => [networkKey(n.name as string), n]))

    for (const spec of specs) {
      const found = byName.get(networkKey(spec.name))
      const label = spec.name

      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      if (spec.subnetCidr) {
        const liveSubnet = found.subnet4 && found['mask-length4'] != null ? `${found.subnet4}/${found['mask-length4']}` : '(none)'
        if (liveSubnet !== spec.subnetCidr) {
          diffs.push({ field: `${label}.subnetCidr`, expected: spec.subnetCidr, actual: liveSubnet, severity: 'critical' })
        }
      }
      if (spec.subnet6Cidr) {
        const liveSubnet6 = found.subnet6 && found['mask-length6'] != null ? `${found.subnet6}/${found['mask-length6']}` : '(none)'
        if (liveSubnet6 !== spec.subnet6Cidr) {
          diffs.push({ field: `${label}.subnet6Cidr`, expected: spec.subnet6Cidr, actual: liveSubnet6, severity: 'critical' })
        }
      }
      if (spec.comments || found.comments) {
        const liveComments = found.comments ?? ''
        if (liveComments !== spec.comments) {
          diffs.push({ field: `${label}.comments`, expected: spec.comments, actual: liveComments, severity: 'warning' })
        }
      }
      if (spec.color && found.color && found.color !== spec.color) {
        diffs.push({ field: `${label}.color`, expected: spec.color, actual: found.color, severity: 'warning' })
      }
      const liveTags = liveTagNames(found.tags)
      if (!sameStringSet(liveTags, spec.tags)) {
        diffs.push({
          field: `${label}.tags`,
          expected: spec.tags.join(', ') || '(none)',
          actual: liveTags.join(', ') || '(none)',
          severity: 'warning',
        })
      }
    }
  } catch {
    diffs.push({ field: 'checkpoint', expected: 'reachable', actual: 'unreachable', severity: 'critical' })
  } finally {
    await client.logout()
  }

  return { hasDrift: diffs.length > 0, diffs }
}
