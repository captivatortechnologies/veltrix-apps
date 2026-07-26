import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQRadarClient, parseJson, readQRadarSettings, resolveQRadarCredential } from '../../lib/qradar'
import { extractReferenceSetSpecs, type LiveReferenceSet } from './validate'

type Diffs = DriftResult['diffs']

function sortedJson(v: string[]): string {
  return JSON.stringify([...v].sort())
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  // Without a usable credential we can't read live state — assert no drift.
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildQRadarClient(cred, settings)

  const specs = extractReferenceSetSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  for (const spec of specs) {
    const getRes = await client.getSet(spec.name)
    if (getRes.status === 404) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (!getRes.ok) continue
    const live = parseJson<LiveReferenceSet>(getRes.body)
    const liveType = (live?.element_type ?? '').toUpperCase()
    if (liveType && liveType !== spec.elementType) {
      diffs.push({ field: `${spec.name}.element_type`, expected: spec.elementType, actual: liveType, severity: 'critical' })
    }
    const liveValues = (live?.data ?? []).map((d) => d.value ?? '').filter(Boolean)
    if (sortedJson(liveValues) !== sortedJson(spec.values)) {
      diffs.push({ field: `${spec.name}.values`, expected: [...spec.values].sort(), actual: [...liveValues].sort(), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
