import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCbClient, parseJson, readCbSettings, resolveCbCredential } from '../../lib/carbonblack'
import { extractWatchlistSpecs, type LiveWatchlist } from './validate'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readCbSettings(ctx.settings)
  const cred = resolveCbCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildCbClient(cred, settings)
  const watchlistsPath = `/threathunter/watchlistmgr/v3/orgs/${cred.orgKey}/watchlists`

  const specs = extractWatchlistSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listRes = await client.get(watchlistsPath)
  if (!listRes.ok) return { hasDrift: false, diffs: [] }
  const parsed = parseJson<{ results?: LiveWatchlist[] } | LiveWatchlist[]>(listRes.body)
  const watchlists = Array.isArray(parsed) ? parsed : parsed?.results ?? []
  const liveByName = new Map(watchlists.filter((w) => w.name).map((w) => [w.name!.toLowerCase(), w]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live?.id) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((live.description ?? '') !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: live.description ?? '', severity: 'warning' })
    }
    const liveFeedId = live.classifier?.value ?? ''
    if (liveFeedId !== spec.feedId) {
      diffs.push({ field: `${spec.name}.feedId`, expected: spec.feedId, actual: liveFeedId, severity: 'warning' })
    }
    if ((live.tags_enabled ?? false) !== spec.tagsEnabled) {
      diffs.push({ field: `${spec.name}.tags_enabled`, expected: spec.tagsEnabled, actual: live.tags_enabled ?? false, severity: 'warning' })
    }
    if ((live.alerts_enabled ?? false) !== spec.alertsEnabled) {
      diffs.push({ field: `${spec.name}.alerts_enabled`, expected: spec.alertsEnabled, actual: live.alerts_enabled ?? false, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
