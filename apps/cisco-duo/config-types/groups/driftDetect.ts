import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildDuoClient, readDuoSettings, resolveDuoCredential } from '../../lib/duo'
import { extractGroupSpecs, type LiveGroup } from './validate'

const BASE = '/admin/v1/groups'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readDuoSettings(ctx.settings)
  const cred = resolveDuoCredential(ctx.credential, settings)
  // Without a usable credential we can't read live state — assert no drift.
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildDuoClient(cred, settings)

  const specs = extractGroupSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveGroup>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((g) => g.name).map((g) => [g.name!.toLowerCase(), g]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    const liveDesc = (live.desc ?? '') as string
    if (liveDesc !== spec.desc) {
      diffs.push({ field: `${spec.name}.desc`, expected: spec.desc, actual: liveDesc, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
