import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildNetskopeClient, readNetskopeSettings, resolveNetskopeCredential } from '../../lib/netskope'
import { extractUrlListSpecs, type LiveUrlList } from './validate'

const BASE = '/policy/urllist'

type Diffs = DriftResult['diffs']

function sortedJson(v: string[]): string {
  return JSON.stringify([...v].sort())
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  // Without a usable credential we can't read live state — assert no drift.
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildNetskopeClient(cred, settings)

  const specs = extractUrlListSpecs(ctx.deployedConfig).filter((s) => s.name)
  // Compare against the applied (enforced) state, not pending edits.
  const listed = await client.getAll<LiveUrlList>(`${BASE}?pending=applied`)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((l) => l.name).map((l) => [l.name!.toLowerCase(), l]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    const liveType = live.data?.type ?? 'exact'
    if (liveType !== spec.type) {
      diffs.push({ field: `${spec.name}.type`, expected: spec.type, actual: liveType, severity: 'warning' })
    }
    const liveUrls = live.data?.urls ?? []
    if (sortedJson(liveUrls) !== sortedJson(spec.urls)) {
      diffs.push({ field: `${spec.name}.urls`, expected: [...spec.urls].sort(), actual: [...liveUrls].sort(), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
