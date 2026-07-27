import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFmgClient, readFmgSettings, resolveFmgCredential } from '../../lib/fortimanager'
import { extractTrafficShaperSpecs, type LiveTrafficShaper } from './validate'
import { trafficShaperUrl } from './deploy'

type Diffs = DriftResult['diffs']

/** Compare a declared string against a live value only when the live echo is a
 *  string — FMG returns some enums as numeric indexes, which we skip to avoid
 *  false drift. */
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
  const url = trafficShaperUrl(settings.adom)

  const specs = extractTrafficShaperSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  try {
    const listed = await client.get(url)
    if (!listed.ok) return { hasDrift: false, diffs: [] }
    const live = Array.isArray(listed.data) ? (listed.data as LiveTrafficShaper[]) : []
    const liveByName = new Map(live.filter((s) => s.name).map((s) => [s.name!.toLowerCase(), s]))

    for (const spec of specs) {
      const s = liveByName.get(spec.name.toLowerCase())
      if (!s) {
        diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
        continue
      }
      pushNum(diffs, `${spec.name}.guaranteed-bandwidth`, spec.guaranteedBandwidth, s['guaranteed-bandwidth'])
      pushNum(diffs, `${spec.name}.maximum-bandwidth`, spec.maximumBandwidth, s['maximum-bandwidth'])
      pushStr(diffs, `${spec.name}.bandwidth-unit`, spec.bandwidthUnit, s['bandwidth-unit'])
      pushStr(diffs, `${spec.name}.priority`, spec.priority, s.priority)
      pushStr(diffs, `${spec.name}.per-policy`, spec.perPolicy, s['per-policy'])
      pushStr(diffs, `${spec.name}.diffserv`, spec.diffserv, s.diffserv)
    }
  } finally {
    await client.logout()
  }

  return { hasDrift: diffs.length > 0, diffs }
}
