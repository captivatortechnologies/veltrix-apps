import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSecOpsClient, readSecOpsSettings, resolveSecOpsCredential } from '../../lib/googlesecops'
import { extractFeedSpecs } from './validate'
import { listFeeds } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const listed = await listFeeds(client, parent)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const byDisplayName = new Map(listed.feeds.map((fd) => [fd.displayName ?? '', fd]))

  const specs = extractFeedSpecs(ctx.deployedConfig).filter((s) => s.displayName && s.details)
  const diffs: Diffs = []
  for (const spec of specs) {
    const live = byDisplayName.get(spec.displayName)
    if (!live) {
      diffs.push({ field: spec.displayName, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    // Source settings can carry write-only secrets that never round-trip, so drift
    // is limited to the stable identity fields — source type and log type.
    if ((live.details?.feedSourceType ?? '') !== spec.feedSourceType) {
      diffs.push({ field: `${spec.displayName}.feedSourceType`, expected: spec.feedSourceType, actual: live.details?.feedSourceType ?? '', severity: 'warning' })
    }
    if ((live.details?.logType ?? '') !== spec.logType) {
      diffs.push({ field: `${spec.displayName}.logType`, expected: spec.logType, actual: live.details?.logType ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
