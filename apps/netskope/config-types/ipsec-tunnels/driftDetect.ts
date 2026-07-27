import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildNetskopeClient, readNetskopeSettings, resolveNetskopeCredential } from '../../lib/netskope'
import { extractIpsecTunnelSpecs, type LiveIpsecTunnel } from './validate'

const BASE = '/steering/ipsec/tunnels'
const LIST_KEY = 'tunnels'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildNetskopeClient(cred, settings)

  const specs = extractIpsecTunnelSpecs(ctx.deployedConfig).filter((s) => s.site)
  const listed = await client.getAllNpa<LiveIpsecTunnel>(BASE, LIST_KEY)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveBySite = new Map(listed.items.filter((t) => t.site).map((t) => [t.site!.toLowerCase(), t]))

  // psk is write-only and POP names can drop from list responses; neither is diffed.
  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveBySite.get(spec.site.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.site, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((live.source_ip ?? '') !== spec.sourceIp) {
      diffs.push({ field: `${spec.site}.source_ip`, expected: spec.sourceIp, actual: live.source_ip ?? '', severity: 'warning' })
    }
    if ((live.enabled !== false) !== spec.enabled) {
      diffs.push({ field: `${spec.site}.enabled`, expected: String(spec.enabled), actual: String(live.enabled !== false), severity: 'warning' })
    }
    if (spec.encryption && (live.encryption ?? '') !== spec.encryption) {
      diffs.push({ field: `${spec.site}.encryption`, expected: spec.encryption, actual: live.encryption ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
