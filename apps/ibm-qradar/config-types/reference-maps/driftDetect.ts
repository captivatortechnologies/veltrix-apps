import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQRadarClient, parseJson, readQRadarSettings, resolveQRadarCredential } from '../../lib/qradar'
import { extractReferenceMapSpecs, type LiveReferenceMap } from './validate'

const enc = encodeURIComponent

type Diffs = DriftResult['diffs']

function sortedPairs(entries: Array<{ key: string; value: string }>): string {
  return JSON.stringify([...entries].map((e) => `${e.key}=${e.value}`).sort())
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildQRadarClient(cred, settings)

  const specs = extractReferenceMapSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  for (const spec of specs) {
    const getRes = await client.request('GET', `/reference_data/maps/${enc(spec.name)}`, { range: 'items=0-9999' })
    if (getRes.status === 404) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (!getRes.ok) continue
    const live = parseJson<LiveReferenceMap>(getRes.body)
    const liveType = (live?.element_type ?? '').toUpperCase()
    if (liveType && liveType !== spec.elementType) {
      diffs.push({ field: `${spec.name}.element_type`, expected: spec.elementType, actual: liveType, severity: 'critical' })
    }
    const liveEntries = Object.keys(live?.data ?? {}).map((key) => ({ key, value: live!.data![key]?.value ?? '' }))
    if (sortedPairs(liveEntries) !== sortedPairs(spec.entries)) {
      diffs.push({ field: `${spec.name}.entries`, expected: spec.entries.map((e) => `${e.key}=${e.value}`).sort(), actual: liveEntries.map((e) => `${e.key}=${e.value}`).sort(), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
