import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQRadarClient, readQRadarSettings, resolveQRadarCredential } from '../../lib/qradar'
import { extractRemoteNetworkSpecs } from './validate'
import { listRemoteNetworks } from './deploy'

type Diffs = DriftResult['diffs']

function sameCidrs(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sb = new Set(b)
  return a.every((x) => sb.has(x))
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildQRadarClient(cred, settings)

  const specs = extractRemoteNetworkSpecs(ctx.deployedConfig).filter((s) => s.name)
  const live = await listRemoteNetworks(client)
  const byName = new Map(live.filter((n) => n.name).map((n) => [String(n.name).toLowerCase(), n]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const net = byName.get(spec.name.toLowerCase())
    if (!net) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((net.description ?? '') !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: net.description ?? '', severity: 'warning' })
    }
    if ((net.group ?? '') !== spec.group) {
      diffs.push({ field: `${spec.name}.group`, expected: spec.group, actual: net.group ?? '', severity: 'warning' })
    }
    if (!sameCidrs(net.cidrs ?? [], spec.cidrs)) {
      diffs.push({ field: `${spec.name}.cidrs`, expected: spec.cidrs.join(', '), actual: (net.cidrs ?? []).join(', '), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
