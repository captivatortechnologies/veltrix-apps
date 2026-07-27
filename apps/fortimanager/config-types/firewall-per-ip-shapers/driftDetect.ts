import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFmgClient, readFmgSettings, resolveFmgCredential } from '../../lib/fortimanager'
import { extractPerIpShaperSpecs, type LivePerIpShaper } from './validate'
import { perIpShaperUrl } from './deploy'

type Diffs = DriftResult['diffs']

function pushStr(diffs: Diffs, field: string, want: string, live: unknown, severity: 'warning' | 'critical' = 'warning'): void {
  if (!want) return
  if (typeof live !== 'string') return
  if (want !== live) diffs.push({ field, expected: want, actual: live, severity })
}

function pushNum(diffs: Diffs, field: string, want: number | undefined, live: unknown, severity: 'warning' | 'critical' = 'warning'): void {
  if (want === undefined) return
  if (live === undefined || live === null) return
  if (String(want) !== String(live)) diffs.push({ field, expected: want, actual: live, severity })
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readFmgSettings(ctx.settings)
  const cred = resolveFmgCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildFmgClient(cred, settings)
  const url = perIpShaperUrl(settings.adom)

  const specs = extractPerIpShaperSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  try {
    const listed = await client.get(url)
    if (!listed.ok) return { hasDrift: false, diffs: [] }
    const live = Array.isArray(listed.data) ? (listed.data as LivePerIpShaper[]) : []
    const liveByName = new Map(live.filter((s) => s.name).map((s) => [s.name!.toLowerCase(), s]))

    for (const spec of specs) {
      const s = liveByName.get(spec.name.toLowerCase())
      if (!s) {
        diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
        continue
      }
      pushNum(diffs, `${spec.name}.max-bandwidth`, spec.maxBandwidth, s['max-bandwidth'])
      pushStr(diffs, `${spec.name}.bandwidth-unit`, spec.bandwidthUnit, s['bandwidth-unit'])
      pushNum(diffs, `${spec.name}.max-concurrent-session`, spec.maxConcurrentSession, s['max-concurrent-session'])
      pushNum(diffs, `${spec.name}.max-concurrent-tcp-session`, spec.maxConcurrentTcpSession, s['max-concurrent-tcp-session'])
      pushNum(diffs, `${spec.name}.max-concurrent-udp-session`, spec.maxConcurrentUdpSession, s['max-concurrent-udp-session'])
      pushStr(diffs, `${spec.name}.diffserv-forward`, spec.diffservForward, s['diffserv-forward'])
      pushStr(diffs, `${spec.name}.diffserv-reverse`, spec.diffservReverse, s['diffserv-reverse'])
    }
  } finally {
    await client.logout()
  }

  return { hasDrift: diffs.length > 0, diffs }
}
