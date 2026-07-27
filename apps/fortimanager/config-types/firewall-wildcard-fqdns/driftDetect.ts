import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFmgClient, readFmgSettings, resolveFmgCredential } from '../../lib/fortimanager'
import { extractWildcardFqdnSpecs, type LiveWildcardFqdn } from './validate'
import { wildcardFqdnUrl } from './deploy'

type Diffs = DriftResult['diffs']

function pushIfDiff(diffs: Diffs, field: string, want: unknown, actual: unknown, severity: 'warning' | 'critical' = 'warning'): void {
  if (String(want) !== String(actual)) diffs.push({ field, expected: want, actual, severity })
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readFmgSettings(ctx.settings)
  const cred = resolveFmgCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildFmgClient(cred, settings)
  const url = wildcardFqdnUrl(settings.adom)

  const specs = extractWildcardFqdnSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  try {
    const listed = await client.get(url)
    if (!listed.ok) return { hasDrift: false, diffs: [] }
    const live = Array.isArray(listed.data) ? (listed.data as LiveWildcardFqdn[]) : []
    const liveByName = new Map(live.filter((w) => w.name).map((w) => [w.name!.toLowerCase(), w]))

    for (const spec of specs) {
      const w = liveByName.get(spec.name.toLowerCase())
      if (!w) {
        diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
        continue
      }
      pushIfDiff(diffs, `${spec.name}.wildcard-fqdn`, spec.wildcardFqdn, w['wildcard-fqdn'] ?? '', 'critical')
      if (spec.comment || w.comment) {
        pushIfDiff(diffs, `${spec.name}.comment`, spec.comment, w.comment ?? '', 'warning')
      }
    }
  } finally {
    await client.logout()
  }

  return { hasDrift: diffs.length > 0, diffs }
}
