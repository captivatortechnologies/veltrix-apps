import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCbClient, parseJson, readCbSettings, resolveCbCredential } from '../../lib/carbonblack'
import { extractReportSpecs, type LiveReport } from './validate'
import type { RollbackEntry } from './deploy'

type Diffs = DriftResult['diffs']

function sortedJson(v: string[]): string {
  return JSON.stringify([...v].sort())
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readCbSettings(ctx.settings)
  const cred = resolveCbCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildCbClient(cred, settings)
  const base = client.watchlistReportsPath()

  const specs = extractReportSpecs(ctx.deployedConfig).filter((s) => s.title)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // No list-all endpoint — resolve each report's server id from the latest
  // deployment's stored rollback entries, then GET it by id.
  let prior: RollbackEntry[] = []
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: RollbackEntry[] } | undefined
    prior = Array.isArray(data?.entries) ? data!.entries : []
  } catch {
    return { hasDrift: false, diffs: [] }
  }
  const idByItem = new Map<string, string>()
  const idByTitle = new Map<string, string>()
  for (const p of prior) {
    if (p.reportId && p.itemId) idByItem.set(p.itemId, p.reportId)
    if (p.reportId && p.title) idByTitle.set(p.title.toLowerCase(), p.reportId)
  }

  const diffs: Diffs = []
  for (const spec of specs) {
    const reportId = (spec.itemId && idByItem.get(spec.itemId)) || idByTitle.get(spec.title.toLowerCase())
    if (!reportId) continue

    const res = await client.get(`${base}/${reportId}`)
    if (res.status === 404) {
      diffs.push({ field: spec.title, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (!res.ok) continue
    const live = parseJson<LiveReport>(res.body)
    if (!live) continue

    if ((live.description ?? '') !== spec.description) {
      diffs.push({ field: `${spec.title}.description`, expected: spec.description, actual: live.description ?? '', severity: 'warning' })
    }
    if ((live.severity ?? 0) !== spec.severity) {
      diffs.push({ field: `${spec.title}.severity`, expected: spec.severity, actual: live.severity ?? 0, severity: 'warning' })
    }
    const liveValues = (live.iocs_v2 ?? []).filter((i) => i.field === spec.iocField).flatMap((i) => i.values ?? [])
    if (sortedJson(liveValues) !== sortedJson(spec.values)) {
      diffs.push({ field: `${spec.title}.values`, expected: [...spec.values].sort(), actual: [...liveValues].sort(), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
