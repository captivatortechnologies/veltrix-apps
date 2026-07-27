import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFmgClient, readFmgSettings, resolveFmgCredential } from '../../lib/fortimanager'
import { extractVipSpecs, normalizeScalar, normalizeVipIp, type LiveVip } from './validate'
import { vipUrl } from './deploy'

type Diffs = DriftResult['diffs']

function pushIfDiff(diffs: Diffs, field: string, want: unknown, actual: unknown, severity: 'warning' | 'critical' = 'warning'): void {
  if (String(want) !== String(actual)) diffs.push({ field, expected: want, actual, severity })
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readFmgSettings(ctx.settings)
  const cred = resolveFmgCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildFmgClient(cred, settings)
  const url = vipUrl(settings.adom)

  const specs = extractVipSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  try {
    const listed = await client.get(url)
    if (!listed.ok) return { hasDrift: false, diffs: [] }
    const live = Array.isArray(listed.data) ? (listed.data as LiveVip[]) : []
    const liveByName = new Map(live.filter((v) => v.name).map((v) => [v.name!.toLowerCase(), v]))

    for (const spec of specs) {
      const v = liveByName.get(spec.name.toLowerCase())
      if (!v) {
        diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
        continue
      }
      pushIfDiff(diffs, `${spec.name}.extip`, spec.extip, normalizeVipIp(v.extip), 'critical')
      pushIfDiff(diffs, `${spec.name}.mappedip`, spec.mappedip, normalizeVipIp(v.mappedip), 'critical')
      pushIfDiff(diffs, `${spec.name}.extintf`, spec.extintf, normalizeScalar(v.extintf) || 'any')
      pushIfDiff(diffs, `${spec.name}.portforward`, spec.portforward, v.portforward ?? 'disable')
      if (spec.portforward === 'enable') {
        pushIfDiff(diffs, `${spec.name}.extport`, spec.extport, v.extport ?? '')
        pushIfDiff(diffs, `${spec.name}.mappedport`, spec.mappedport, v.mappedport ?? '')
        pushIfDiff(diffs, `${spec.name}.protocol`, spec.protocol, String(v.protocol ?? ''))
      }
      if (spec.comment || v.comment) {
        pushIfDiff(diffs, `${spec.name}.comment`, spec.comment, v.comment ?? '')
      }
    }
  } finally {
    await client.logout()
  }

  return { hasDrift: diffs.length > 0, diffs }
}
