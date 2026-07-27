import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFmgClient, readFmgSettings, resolveFmgCredential } from '../../lib/fortimanager'
import { extractIpsSensorSpecs, type LiveIpsSensor } from './validate'
import { ipsSensorUrl } from './deploy'

type Diffs = DriftResult['diffs']

function pushStr(diffs: Diffs, field: string, want: string, live: unknown, severity: 'warning' | 'critical' = 'warning'): void {
  if (!want) return
  if (typeof live !== 'string') return
  if (want !== live) diffs.push({ field, expected: want, actual: live, severity })
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readFmgSettings(ctx.settings)
  const cred = resolveFmgCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildFmgClient(cred, settings)
  const url = ipsSensorUrl(settings.adom)

  const specs = extractIpsSensorSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  try {
    const listed = await client.get(url)
    if (!listed.ok) return { hasDrift: false, diffs: [] }
    const live = Array.isArray(listed.data) ? (listed.data as LiveIpsSensor[]) : []
    const liveByName = new Map(live.filter((s) => s.name).map((s) => [s.name!.toLowerCase(), s]))

    for (const spec of specs) {
      const s = liveByName.get(spec.name.toLowerCase())
      if (!s) {
        diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
        continue
      }
      pushStr(diffs, `${spec.name}.block-malicious-url`, spec.blockMaliciousUrl, s['block-malicious-url'])
      pushStr(diffs, `${spec.name}.extended-log`, spec.extendedLog, s['extended-log'])
      pushStr(diffs, `${spec.name}.scan-botnet-connections`, spec.scanBotnetConnections, s['scan-botnet-connections'])
    }
  } finally {
    await client.logout()
  }

  return { hasDrift: diffs.length > 0, diffs }
}
