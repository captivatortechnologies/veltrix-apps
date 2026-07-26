import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCbClient, parseJson, readCbSettings, resolveCbCredential } from '../../lib/carbonblack'
import { extractFeedSpecs, type LiveFeed } from './validate'

type Diffs = DriftResult['diffs']

interface FeedDetail {
  feedinfo?: { summary?: string; category?: string }
  reports?: Array<{ iocs_v2?: Array<{ field?: string; values?: string[] }> }>
}

function sortedJson(v: string[]): string {
  return JSON.stringify([...v].sort())
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readCbSettings(ctx.settings)
  const cred = resolveCbCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildCbClient(cred, settings)
  const feedsPath = `/threathunter/feedmgr/v2/orgs/${cred.orgKey}/feeds`

  const specs = extractFeedSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listRes = await client.get(feedsPath)
  if (!listRes.ok) return { hasDrift: false, diffs: [] }
  const parsed = parseJson<{ results?: LiveFeed[] } | LiveFeed[]>(listRes.body)
  const feeds = Array.isArray(parsed) ? parsed : parsed?.results ?? []
  const liveByName = new Map(feeds.filter((f) => f.name).map((f) => [f.name!.toLowerCase(), f]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live?.id) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    const detailRes = await client.get(`${feedsPath}/${live.id}`)
    if (!detailRes.ok) continue
    const detail = parseJson<FeedDetail>(detailRes.body)
    if ((detail?.feedinfo?.summary ?? '') !== spec.summary) {
      diffs.push({ field: `${spec.name}.summary`, expected: spec.summary, actual: detail?.feedinfo?.summary ?? '', severity: 'warning' })
    }
    const liveValues = (detail?.reports ?? []).flatMap((r) => (r.iocs_v2 ?? []).filter((i) => i.field === spec.iocField).flatMap((i) => i.values ?? []))
    if (sortedJson(liveValues) !== sortedJson(spec.values)) {
      diffs.push({ field: `${spec.name}.values`, expected: [...spec.values].sort(), actual: [...liveValues].sort(), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
