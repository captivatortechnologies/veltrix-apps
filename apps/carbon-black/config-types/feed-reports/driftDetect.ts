import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCbClient, parseJson, readCbSettings, resolveCbCredential } from '../../lib/carbonblack'
import type { LiveFeed } from '../threat-feeds/validate'
import { extractReportSpecs, type LiveReport } from './validate'

type Diffs = DriftResult['diffs']

function sortedJson(v: string[]): string {
  return JSON.stringify([...v].sort())
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readCbSettings(ctx.settings)
  const cred = resolveCbCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildCbClient(cred, settings)
  const feedsPath = `/threathunter/feedmgr/v2/orgs/${cred.orgKey}/feeds`

  const specs = extractReportSpecs(ctx.deployedConfig).filter((s) => s.feedName && s.title)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const feedsRes = await client.get(feedsPath)
  if (!feedsRes.ok) return { hasDrift: false, diffs: [] }
  const feedsParsed = parseJson<{ results?: LiveFeed[] } | LiveFeed[]>(feedsRes.body)
  const feeds = Array.isArray(feedsParsed) ? feedsParsed : feedsParsed?.results ?? []
  const feedByName = new Map(feeds.filter((f) => f.name).map((f) => [f.name!.toLowerCase(), f]))

  // Cache each feed's reports (keyed by title) so we list a feed only once.
  const reportsByFeed = new Map<string, Map<string, LiveReport>>()
  const diffs: Diffs = []

  for (const spec of specs) {
    const feed = feedByName.get(spec.feedName.toLowerCase())
    if (!feed?.id) {
      diffs.push({ field: spec.title, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    let byTitle = reportsByFeed.get(feed.id)
    if (!byTitle) {
      byTitle = new Map<string, LiveReport>()
      const res = await client.get(`${feedsPath}/${feed.id}/reports`)
      if (res.ok) {
        const parsed = parseJson<{ results?: LiveReport[] } | LiveReport[]>(res.body)
        const reports = Array.isArray(parsed) ? parsed : parsed?.results ?? []
        for (const r of reports) if (r.title) byTitle.set(r.title.toLowerCase(), r)
      }
      reportsByFeed.set(feed.id, byTitle)
    }

    const live = byTitle.get(spec.title.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.title, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
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
