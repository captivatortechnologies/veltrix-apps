import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFmgClient, readFmgSettings, resolveFmgCredential } from '../../lib/fortimanager'
import { extractIpPoolSpecs, type LiveIpPool } from './validate'
import { ippoolUrl } from './deploy'

type Diffs = DriftResult['diffs']

function pushIfDiff(diffs: Diffs, field: string, want: unknown, actual: unknown, severity: 'warning' | 'critical' = 'warning'): void {
  if (String(want) !== String(actual)) diffs.push({ field, expected: want, actual, severity })
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readFmgSettings(ctx.settings)
  const cred = resolveFmgCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildFmgClient(cred, settings)
  const url = ippoolUrl(settings.adom)

  const specs = extractIpPoolSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  try {
    const listed = await client.get(url)
    if (!listed.ok) return { hasDrift: false, diffs: [] }
    const live = Array.isArray(listed.data) ? (listed.data as LiveIpPool[]) : []
    const liveByName = new Map(live.filter((p) => p.name).map((p) => [p.name!.toLowerCase(), p]))

    for (const spec of specs) {
      const p = liveByName.get(spec.name.toLowerCase())
      if (!p) {
        diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
        continue
      }
      if (typeof p.type === 'string' && p.type !== spec.type) {
        diffs.push({ field: `${spec.name}.type`, expected: spec.type, actual: p.type, severity: 'critical' })
      }
      pushIfDiff(diffs, `${spec.name}.startip`, spec.startIp, p.startip ?? '')
      pushIfDiff(diffs, `${spec.name}.endip`, spec.endIp, p.endip ?? '')
      if (spec.comment || p.comments) {
        pushIfDiff(diffs, `${spec.name}.comments`, spec.comment, p.comments ?? '', 'warning')
      }
    }
  } finally {
    await client.logout()
  }

  return { hasDrift: diffs.length > 0, diffs }
}
