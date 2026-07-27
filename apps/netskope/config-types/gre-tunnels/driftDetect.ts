import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildNetskopeClient, readNetskopeSettings, resolveNetskopeCredential } from '../../lib/netskope'
import { extractGreTunnelSpecs, type LiveGreTunnel } from './validate'

const BASE = '/steering/gre/tunnels'
const LIST_KEY = 'tunnels'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildNetskopeClient(cred, settings)

  const specs = extractGreTunnelSpecs(ctx.deployedConfig).filter((s) => s.site)
  const listed = await client.getAllNpa<LiveGreTunnel>(BASE, LIST_KEY)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveBySite = new Map(listed.items.filter((t) => t.site).map((t) => [t.site!.toLowerCase(), t]))

  // POP names can drop from list responses, so they are not diffed (see BUG-014).
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
    if ((live.bandwidth ?? 1000) !== spec.bandwidth) {
      diffs.push({ field: `${spec.site}.bandwidth`, expected: String(spec.bandwidth), actual: String(live.bandwidth ?? 1000), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
