import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildFmgClient, readFmgSettings, resolveFmgCredential } from '../../lib/fortimanager'
import { extractVipGroupSpecs, liveMemberNames, normalizeScalar, type LiveVipGroup } from './validate'
import { vipgrpUrl } from './deploy'

type Diffs = DriftResult['diffs']

function sortedJson(v: string[]): string {
  return JSON.stringify([...v].sort())
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readFmgSettings(ctx.settings)
  const cred = resolveFmgCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildFmgClient(cred, settings)
  const url = vipgrpUrl(settings.adom)

  const specs = extractVipGroupSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  try {
    const listed = await client.get(url)
    if (!listed.ok) return { hasDrift: false, diffs: [] }
    const live = Array.isArray(listed.data) ? (listed.data as LiveVipGroup[]) : []
    const liveByName = new Map(live.filter((g) => g.name).map((g) => [g.name!.toLowerCase(), g]))

    for (const spec of specs) {
      const g = liveByName.get(spec.name.toLowerCase())
      if (!g) {
        diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
        continue
      }
      const liveMembers = liveMemberNames(g.member)
      if (sortedJson(liveMembers) !== sortedJson(spec.members)) {
        diffs.push({ field: `${spec.name}.member`, expected: [...spec.members].sort(), actual: liveMembers.sort(), severity: 'warning' })
      }
      if (spec.interface) {
        const iface = normalizeScalar(g.interface)
        if (iface !== spec.interface) diffs.push({ field: `${spec.name}.interface`, expected: spec.interface, actual: iface, severity: 'warning' })
      }
      if (spec.comment || g.comments) {
        if ((g.comments ?? '') !== spec.comment) diffs.push({ field: `${spec.name}.comments`, expected: spec.comment, actual: g.comments ?? '', severity: 'warning' })
      }
    }
  } finally {
    await client.logout()
  }

  return { hasDrift: diffs.length > 0, diffs }
}
