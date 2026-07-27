import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPcClient, parseJson, readPcSettings, resolvePcCredential } from '../../lib/prismacloud'
import { extractTrustedAlertIpSpecs, type LiveTrustedAlertIp } from './validate'

const BASE = '/allow_list/network'

type Diffs = DriftResult['diffs']

function sortedCidrs(cidrs: Array<{ cidr?: string }>): string {
  return JSON.stringify([...cidrs.map((c) => c.cidr ?? '')].sort())
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildPcClient(cred, settings)

  const specs = extractTrustedAlertIpSpecs(ctx.deployedConfig).filter((s) => s.name && !s.cidrsError)
  const res = await client.get(BASE)
  if (!res.ok) return { hasDrift: false, diffs: [] }
  const live = parseJson<LiveTrustedAlertIp[]>(res.body) ?? []
  const liveByName = new Map(live.filter((l) => l.name).map((l) => [l.name!.toLowerCase(), l]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const l = liveByName.get(spec.name.toLowerCase())
    if (!l) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (sortedCidrs(l.cidrs ?? []) !== sortedCidrs(spec.cidrs)) {
      diffs.push({ field: `${spec.name}.cidrs`, expected: 'declared CIDRs', actual: 'live CIDRs differ', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
