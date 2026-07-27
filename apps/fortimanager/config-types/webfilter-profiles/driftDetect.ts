import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFmgClient, readFmgSettings, resolveFmgCredential } from '../../lib/fortimanager'
import { extractWebFilterProfileSpecs, asBool, type LiveWebFilterProfile, type WebFilterProfileSpec } from './validate'
import { webfilterProfileUrl } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readFmgSettings(ctx.settings)
  const cred = resolveFmgCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildFmgClient(cred, settings)
  const url = webfilterProfileUrl(settings.adom)

  const specs = extractWebFilterProfileSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  try {
    const listed = await client.get(url)
    if (!listed.ok) return { hasDrift: false, diffs: [] }
    const live = Array.isArray(listed.data) ? (listed.data as LiveWebFilterProfile[]) : []
    const liveByName = new Map(live.filter((p) => p.name).map((p) => [p.name!.toLowerCase(), p]))

    // Only the first-class scalar toggles are drift-compared; the nested JSON body
    // is intentionally excluded (FortiManager echoes many defaults, so a deep diff
    // would be noise).
    const bools: Array<[keyof WebFilterProfileSpec, keyof LiveWebFilterProfile]> = [
      ['httpsReplacemsg', 'https-replacemsg'],
      ['logAllUrl', 'log-all-url'],
      ['webContentLog', 'web-content-log'],
      ['extendedLog', 'extended-log'],
      ['wisp', 'wisp'],
    ]

    for (const spec of specs) {
      const p = liveByName.get(spec.name.toLowerCase())
      if (!p) {
        diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
        continue
      }
      for (const [specKey, liveKey] of bools) {
        const want = spec[specKey] as boolean
        if (asBool(p[liveKey]) !== want) {
          diffs.push({ field: `${spec.name}.${String(liveKey)}`, expected: want ? 'enable' : 'disable', actual: p[liveKey] ?? '', severity: 'warning' })
        }
      }
      if (spec.comment || p.comment) {
        if ((p.comment ?? '') !== spec.comment) diffs.push({ field: `${spec.name}.comment`, expected: spec.comment, actual: p.comment ?? '', severity: 'warning' })
      }
    }
  } finally {
    await client.logout()
  }

  return { hasDrift: diffs.length > 0, diffs }
}
