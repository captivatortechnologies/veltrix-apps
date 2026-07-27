import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFmgClient, readFmgSettings, resolveFmgCredential } from '../../lib/fortimanager'
import { extractAntivirusProfileSpecs, type LiveAntivirusProfile } from './validate'
import { antivirusProfileUrl } from './deploy'

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
  const url = antivirusProfileUrl(settings.adom)

  const specs = extractAntivirusProfileSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  try {
    const listed = await client.get(url)
    if (!listed.ok) return { hasDrift: false, diffs: [] }
    const live = Array.isArray(listed.data) ? (listed.data as LiveAntivirusProfile[]) : []
    const liveByName = new Map<string, LiveAntivirusProfile>()
    for (const p of live) if (typeof p.name === 'string') liveByName.set(p.name.toLowerCase(), p)

    for (const spec of specs) {
      const p = liveByName.get(spec.name.toLowerCase())
      if (!p) {
        diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
        continue
      }
      pushStr(diffs, `${spec.name}.inspection-mode`, spec.inspectionMode, p['inspection-mode'])
      pushStr(diffs, `${spec.name}.feature-set`, spec.featureSet, p['feature-set'])
      pushStr(diffs, `${spec.name}.analytics-db`, spec.analyticsDb, p['analytics-db'])
      pushStr(diffs, `${spec.name}.mobile-malware-db`, spec.mobileMalwareDb, p['mobile-malware-db'])
      pushStr(diffs, `${spec.name}.scan-mode`, spec.scanMode, p['scan-mode'])
    }
  } finally {
    await client.logout()
  }

  return { hasDrift: diffs.length > 0, diffs }
}
