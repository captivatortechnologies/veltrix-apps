import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildNetskopeClient, readNetskopeSettings, resolveNetskopeCredential } from '../../lib/netskope'
import { extractDestinationProfileSpecs, type LiveDestinationProfile } from './validate'

const BASE = '/profiles/destinations'

type Diffs = DriftResult['diffs']

function sortedSig(tokens: string[]): string {
  return [...tokens].sort().join(',')
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readNetskopeSettings(ctx.settings)
  const cred = resolveNetskopeCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildNetskopeClient(cred, settings)

  const specs = extractDestinationProfileSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveDestinationProfile>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((p) => p.name).map((p) => [p.name!.toLowerCase(), p]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((live.type ?? '') !== spec.type) {
      diffs.push({ field: `${spec.name}.type`, expected: spec.type, actual: live.type ?? '', severity: 'warning' })
    }
    const expectedValues = sortedSig(spec.values)
    const actualValues = sortedSig(live.values ?? [])
    if (expectedValues !== actualValues) {
      diffs.push({ field: `${spec.name}.values`, expected: expectedValues, actual: actualValues, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
