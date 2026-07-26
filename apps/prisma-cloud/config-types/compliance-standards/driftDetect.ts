import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPcClient, parseJson, readPcSettings, resolvePcCredential } from '../../lib/prismacloud'
import { extractComplianceSpecs, type LiveStandard } from './validate'

const BASE = '/compliance'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  // Without a usable credential we can't read live state — assert no drift.
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildPcClient(cred, settings)

  const specs = extractComplianceSpecs(ctx.deployedConfig).filter((s) => s.name)
  const res = await client.get(BASE)
  if (!res.ok) return { hasDrift: false, diffs: [] }
  const items = parseJson<LiveStandard[]>(res.body) ?? []
  const liveByName = new Map(items.filter((s) => s.name).map((s) => [s.name!.toLowerCase(), s]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    const liveDesc = (live.description ?? '') as string
    if (liveDesc !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: liveDesc, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
