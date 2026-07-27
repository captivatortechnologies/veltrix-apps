import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQRadarClient, parseJson, readQRadarSettings, resolveQRadarCredential } from '../../lib/qradar'
import { extractMapOfSetsSpecs, type LiveMapOfSets } from './validate'

const enc = encodeURIComponent

type Diffs = DriftResult['diffs']

function pairKey(pairs: Array<[string, string]>): string {
  return JSON.stringify([...pairs].map(([k, v]) => `${k}=${v}`).sort())
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildQRadarClient(cred, settings)

  const specs = extractMapOfSetsSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  for (const spec of specs) {
    const getRes = await client.request('GET', `/reference_data/map_of_sets/${enc(spec.name)}`, { range: 'items=0-9999' })
    if (getRes.status === 404) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (!getRes.ok) continue
    const live = parseJson<LiveMapOfSets>(getRes.body)
    const liveType = (live?.element_type ?? '').toUpperCase()
    if (liveType && liveType !== spec.elementType) {
      diffs.push({ field: `${spec.name}.element_type`, expected: spec.elementType, actual: liveType, severity: 'critical' })
    }
    const livePairs: Array<[string, string]> = []
    const map = live?.data ?? {}
    for (const key of Object.keys(map)) for (const cell of map[key] ?? []) if (cell.value) livePairs.push([key, cell.value])
    const desiredPairs: Array<[string, string]> = spec.entries.flatMap((e) => e.values.map((v) => [e.key, v] as [string, string]))
    if (pairKey(livePairs) !== pairKey(desiredPairs)) {
      diffs.push({ field: `${spec.name}.entries`, expected: `${desiredPairs.length} pair(s)`, actual: `${livePairs.length} pair(s)`, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
