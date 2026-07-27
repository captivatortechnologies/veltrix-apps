import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQRadarClient, readQRadarSettings, resolveQRadarCredential } from '../../lib/qradar'
import { extractNetworkEntrySpecs, networkKey } from './validate'
import { listStagedNetworks } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildQRadarClient(cred, settings)

  const specs = extractNetworkEntrySpecs(ctx.deployedConfig).filter((s) => s.group && s.name)
  const live = await listStagedNetworks(client)
  const byKey = new Map(live.map((n) => [networkKey(n.group ?? '', n.name ?? ''), n]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const net = byKey.get(networkKey(spec.group, spec.name))
    const label = `${spec.group}/${spec.name}`
    if (!net) {
      diffs.push({ field: label, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((net.cidr ?? '') !== spec.cidr) {
      diffs.push({ field: `${label}.cidr`, expected: spec.cidr, actual: net.cidr ?? '', severity: 'warning' })
    }
    if ((net.description ?? '') !== spec.description) {
      diffs.push({ field: `${label}.description`, expected: spec.description, actual: net.description ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
