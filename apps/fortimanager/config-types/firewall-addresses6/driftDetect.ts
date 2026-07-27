import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFmgClient, readFmgSettings, resolveFmgCredential } from '../../lib/fortimanager'
import { extractAddress6Specs, type LiveAddress6 } from './validate'
import { address6Url } from './deploy'

type Diffs = DriftResult['diffs']

function pushIfDiff(diffs: Diffs, field: string, want: unknown, actual: unknown, severity: 'warning' | 'critical' = 'warning'): void {
  if (String(want).toLowerCase() !== String(actual).toLowerCase()) diffs.push({ field, expected: want, actual, severity })
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readFmgSettings(ctx.settings)
  const cred = resolveFmgCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildFmgClient(cred, settings)
  const url = address6Url(settings.adom)

  const specs = extractAddress6Specs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  try {
    const listed = await client.get(url)
    if (!listed.ok) return { hasDrift: false, diffs: [] }
    const live = Array.isArray(listed.data) ? (listed.data as LiveAddress6[]) : []
    const liveByName = new Map(live.filter((a) => a.name).map((a) => [a.name!.toLowerCase(), a]))

    for (const spec of specs) {
      const l = liveByName.get(spec.name.toLowerCase())
      if (!l) {
        diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
        continue
      }
      if (typeof l.type === 'string' && l.type !== spec.type) {
        diffs.push({ field: `${spec.name}.type`, expected: spec.type, actual: l.type, severity: 'critical' })
      }
      if (spec.type === 'ipprefix') {
        pushIfDiff(diffs, `${spec.name}.ip6`, spec.ip6, l.ip6 ?? '')
      } else if (spec.type === 'iprange') {
        pushIfDiff(diffs, `${spec.name}.start-ip`, spec.startIp, l['start-ip'] ?? '')
        pushIfDiff(diffs, `${spec.name}.end-ip`, spec.endIp, l['end-ip'] ?? '')
      } else if (spec.type === 'fqdn') {
        pushIfDiff(diffs, `${spec.name}.fqdn`, spec.fqdn, l.fqdn ?? '')
      }
      if (spec.comment || l.comment) {
        pushIfDiff(diffs, `${spec.name}.comment`, spec.comment, l.comment ?? '', 'warning')
      }
    }
  } finally {
    await client.logout()
  }

  return { hasDrift: diffs.length > 0, diffs }
}
