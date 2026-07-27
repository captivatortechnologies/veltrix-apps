import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQRadarClient, parseJson, readQRadarSettings, resolveQRadarCredential } from '../../lib/qradar'
import { extractReferenceTableSpecs, type LiveReferenceTable } from './validate'
import { liveCells } from './deploy'

const enc = encodeURIComponent

type Diffs = DriftResult['diffs']

function sortedCells(cells: Array<{ outerKey: string; innerKey: string; value: string }>): string {
  return JSON.stringify([...cells].map((c) => `${c.outerKey}|${c.innerKey}=${c.value}`).sort())
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildQRadarClient(cred, settings)

  const specs = extractReferenceTableSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  for (const spec of specs) {
    const getRes = await client.request('GET', `/reference_data/tables/${enc(spec.name)}`, { range: 'items=0-9999' })
    if (getRes.status === 404) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (!getRes.ok) continue
    const live = parseJson<LiveReferenceTable>(getRes.body)
    const liveType = (live?.element_type ?? '').toUpperCase()
    if (liveType && liveType !== spec.elementType) {
      diffs.push({ field: `${spec.name}.element_type`, expected: spec.elementType, actual: liveType, severity: 'critical' })
    }
    const current = live ? liveCells(live) : []
    if (sortedCells(current) !== sortedCells(spec.cells)) {
      diffs.push({ field: `${spec.name}.cells`, expected: `${spec.cells.length} cell(s)`, actual: `${current.length} cell(s)`, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
