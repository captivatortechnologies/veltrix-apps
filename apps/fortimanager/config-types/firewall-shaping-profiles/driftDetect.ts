import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFmgClient, readFmgSettings, resolveFmgCredential } from '../../lib/fortimanager'
import { extractShapingProfileSpecs, type LiveShapingProfile } from './validate'
import { shapingProfileUrl } from './deploy'

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
  const url = shapingProfileUrl(settings.adom)

  const specs = extractShapingProfileSpecs(ctx.deployedConfig).filter((s) => s.profileName)
  const diffs: Diffs = []
  try {
    const listed = await client.get(url)
    if (!listed.ok) return { hasDrift: false, diffs: [] }
    const live = Array.isArray(listed.data) ? (listed.data as LiveShapingProfile[]) : []
    const liveByName = new Map(live.filter((p) => p['profile-name']).map((p) => [p['profile-name']!.toLowerCase(), p]))

    for (const spec of specs) {
      const p = liveByName.get(spec.profileName.toLowerCase())
      if (!p) {
        diffs.push({ field: spec.profileName, expected: 'present', actual: 'absent', severity: 'critical' })
        continue
      }
      pushStr(diffs, `${spec.profileName}.type`, spec.type, p.type)
      pushNum(diffs, `${spec.profileName}.default-class-id`, spec.defaultClassId, p['default-class-id'])
      if (spec.comment || p.comment) {
        if ((p.comment ?? '') !== spec.comment) diffs.push({ field: `${spec.profileName}.comment`, expected: spec.comment, actual: p.comment ?? '', severity: 'warning' })
      }
    }
  } finally {
    await client.logout()
  }

  return { hasDrift: diffs.length > 0, diffs }
}
