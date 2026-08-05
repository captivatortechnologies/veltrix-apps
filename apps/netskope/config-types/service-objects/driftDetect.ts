import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildNetskopeClient, readNetskopeSettings, resolveNetskopeCredential } from '../../lib/netskope'
import { extractServiceObjectSpecs, isPredefined, type LiveServiceObject } from './validate'

const BASE = '/profiles/serviceobjects'

type Diffs = DriftResult['diffs']

function sortedSig(tokens: string[]): string {
  return [...tokens].sort().join(',')
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildNetskopeClient(cred, settings)

  const specs = extractServiceObjectSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveServiceObject>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((o) => !isPredefined(o) && o.name).map((o) => [o.name!.toLowerCase(), o]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((live.protocols?.icmp === true) !== spec.icmp) {
      diffs.push({ field: `${spec.name}.icmp`, expected: String(spec.icmp), actual: String(live.protocols?.icmp === true), severity: 'warning' })
    }
    const pairs: Array<[string, string[], string[] | undefined]> = [
      ['tcp', spec.tcp, live.protocols?.tcp],
      ['udp', spec.udp, live.protocols?.udp],
      ['tcp_udp', spec.tcpUdp, live.protocols?.tcp_udp],
    ]
    for (const [field, declared, liveArr] of pairs) {
      const expected = sortedSig(declared)
      const actual = sortedSig(liveArr ?? [])
      if (expected !== actual) {
        diffs.push({ field: `${spec.name}.${field}`, expected, actual, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
