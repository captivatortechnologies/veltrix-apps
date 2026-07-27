import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFmgClient, readFmgSettings, resolveFmgCredential } from '../../lib/fortimanager'
import { extractInternetServiceCustomSpecs, type LiveInternetServiceCustom } from './validate'
import { internetServiceCustomUrl } from './deploy'

type Diffs = DriftResult['diffs']

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
  const url = internetServiceCustomUrl(settings.adom)

  const specs = extractInternetServiceCustomSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  try {
    const listed = await client.get(url)
    if (!listed.ok) return { hasDrift: false, diffs: [] }
    const live = Array.isArray(listed.data) ? (listed.data as LiveInternetServiceCustom[]) : []
    const liveByName = new Map(live.filter((s) => s.name).map((s) => [s.name!.toLowerCase(), s]))

    for (const spec of specs) {
      const s = liveByName.get(spec.name.toLowerCase())
      if (!s) {
        diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
        continue
      }
      pushNum(diffs, `${spec.name}.reputation`, spec.reputation, s.reputation)
      pushNum(diffs, `${spec.name}.master-service-id`, spec.masterServiceId, s['master-service-id'])
      if (spec.comment || s.comment) {
        if ((s.comment ?? '') !== spec.comment) diffs.push({ field: `${spec.name}.comment`, expected: spec.comment, actual: s.comment ?? '', severity: 'warning' })
      }
    }
  } finally {
    await client.logout()
  }

  return { hasDrift: diffs.length > 0, diffs }
}
