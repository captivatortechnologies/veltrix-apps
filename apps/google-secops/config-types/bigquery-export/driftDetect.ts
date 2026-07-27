import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSecOpsClient, parseJson, readSecOpsSettings, resolveSecOpsCredential } from '../../lib/googlesecops'
import { BQ_SOURCES, extractBigQueryExportSpec, type LiveBigQueryExport } from './validate'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const spec = extractBigQueryExportSpec(ctx.deployedConfig)
  if (!spec) return { hasDrift: false, diffs: [] }

  const getRes = await client.request('GET', `${parent}/bigQueryExport`)
  if (!getRes.ok) return { hasDrift: false, diffs: [] }
  const live = parseJson<LiveBigQueryExport>(getRes.body) ?? {}

  const diffs: Diffs = []
  for (const s of BQ_SOURCES) {
    const want = spec.sources[s.key]
    const liveSettings = (live as Record<string, { enabled?: boolean; retentionDays?: number } | undefined>)[s.settings]
    const liveEnabled = liveSettings?.enabled ?? false
    const liveRetention = liveSettings?.retentionDays ?? 0
    if (liveEnabled !== want.enabled) {
      diffs.push({ field: `${s.key}.enabled`, expected: String(want.enabled), actual: String(liveEnabled), severity: 'warning' })
    } else if (want.enabled && liveRetention !== want.retentionDays) {
      diffs.push({ field: `${s.key}.retentionDays`, expected: String(want.retentionDays), actual: String(liveRetention), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
