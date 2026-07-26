import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFmgClient, readFmgSettings, resolveFmgCredential } from '../../lib/fortimanager'
import { extractServiceSpecs, type LiveService } from './validate'
import { serviceUrl } from './deploy'

type Diffs = DriftResult['diffs']

function ports(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x))
  if (typeof v === 'string') return v.split(/[\s,]+/).filter(Boolean)
  return []
}

function sortedJson(v: string[]): string {
  return JSON.stringify([...v].sort())
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readFmgSettings(ctx.settings)
  const cred = resolveFmgCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildFmgClient(cred, settings)
  const url = serviceUrl(settings.adom)

  const specs = extractServiceSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  try {
    const listed = await client.get(url)
    if (!listed.ok) return { hasDrift: false, diffs: [] }
    const live = Array.isArray(listed.data) ? (listed.data as LiveService[]) : []
    const liveByName = new Map(live.filter((s) => s.name).map((s) => [s.name!.toLowerCase(), s]))

    for (const spec of specs) {
      const l = liveByName.get(spec.name.toLowerCase())
      if (!l) {
        diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
        continue
      }
      if (typeof l.protocol === 'string' && l.protocol !== spec.protocol) {
        diffs.push({ field: `${spec.name}.protocol`, expected: spec.protocol, actual: l.protocol, severity: 'critical' })
      }
      if (spec.protocol === 'TCP/UDP/SCTP') {
        for (const [field, want] of [['tcp-portrange', spec.tcpPortrange], ['udp-portrange', spec.udpPortrange], ['sctp-portrange', spec.sctpPortrange]] as const) {
          const liveP = ports(l[field])
          if (sortedJson(liveP) !== sortedJson(want)) {
            diffs.push({ field: `${spec.name}.${field}`, expected: [...want].sort(), actual: liveP.sort(), severity: 'warning' })
          }
        }
      }
      if (spec.comment || l.comment) {
        if ((l.comment ?? '') !== spec.comment) diffs.push({ field: `${spec.name}.comment`, expected: spec.comment, actual: l.comment ?? '', severity: 'warning' })
      }
    }
  } finally {
    await client.logout()
  }

  return { hasDrift: diffs.length > 0, diffs }
}
