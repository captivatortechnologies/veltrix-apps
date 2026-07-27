import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSecOpsClient, readSecOpsSettings, resolveSecOpsCredential } from '../../lib/googlesecops'
import { extractWatchlistSpecs } from './validate'
import { listWatchlists } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const listed = await listWatchlists(client, parent)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const byDisplayName = new Map(listed.watchlists.map((w) => [w.displayName ?? '', w]))

  const specs = extractWatchlistSpecs(ctx.deployedConfig).filter((s) => s.displayName)
  const diffs: Diffs = []
  for (const spec of specs) {
    const live = byDisplayName.get(spec.displayName)
    if (!live) {
      diffs.push({ field: spec.displayName, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((live.description ?? '') !== spec.description) {
      diffs.push({ field: `${spec.displayName}.description`, expected: spec.description, actual: live.description ?? '', severity: 'warning' })
    }
    if ((live.multiplyingFactor ?? 1) !== spec.multiplyingFactor) {
      diffs.push({ field: `${spec.displayName}.multiplyingFactor`, expected: String(spec.multiplyingFactor), actual: String(live.multiplyingFactor ?? 1), severity: 'warning' })
    }
    if ((live.watchlistUserPreferences?.pinned ?? false) !== spec.pinned) {
      diffs.push({ field: `${spec.displayName}.pinned`, expected: String(spec.pinned), actual: String(live.watchlistUserPreferences?.pinned ?? false), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
