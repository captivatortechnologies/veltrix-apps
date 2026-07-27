import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildNetskopeClient, readNetskopeSettings, resolveNetskopeCredential } from '../../lib/netskope'
import { extractPrivateAppSpecs, livePrivateAppName, type LivePrivateApp, type PrivateAppSpec } from './validate'

const BASE = '/steering/apps/private'
const LIST_KEY = 'private_apps'

type Diffs = DriftResult['diffs']

/** Normalise ports for a protocol type into a sorted, comma-joined signature. */
function specPortSig(spec: PrivateAppSpec): string {
  const sig = (tokens: string[]): string => [...tokens].sort().join(',')
  return `tcp[${sig(spec.tcpPorts)}] udp[${sig(spec.udpPorts)}]`
}

function livePortSig(live: LivePrivateApp): string {
  const byType: Record<string, string[]> = { tcp: [], udp: [] }
  for (const p of live.protocols ?? []) {
    const type = (p.type ?? '').toLowerCase()
    if (!byType[type]) byType[type] = []
    for (const tok of (p.port ?? '').split(',').map((t) => t.trim()).filter(Boolean)) byType[type].push(tok)
  }
  return `tcp[${[...byType.tcp].sort().join(',')}] udp[${[...byType.udp].sort().join(',')}]`
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildNetskopeClient(cred, settings)

  const specs = extractPrivateAppSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAllNpa<LivePrivateApp>(BASE, LIST_KEY)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((a) => livePrivateAppName(a)).map((a) => [livePrivateAppName(a).toLowerCase(), a]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((live.host ?? '') !== spec.host) {
      diffs.push({ field: `${spec.name}.host`, expected: spec.host, actual: live.host ?? '', severity: 'warning' })
    }
    const expectedPorts = specPortSig(spec)
    const actualPorts = livePortSig(live)
    if (expectedPorts !== actualPorts) {
      diffs.push({ field: `${spec.name}.protocols`, expected: expectedPorts, actual: actualPorts, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
