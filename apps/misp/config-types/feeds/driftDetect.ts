import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, getJson } from '../../lib/mispApi'
import { feedsFromList, findFeed, normalizeEnabled } from './_shared'

/**
 * Drift for threat feeds: compare the enabled state and URL we declare against the
 * live feed in MISP. Best-effort — a feed that can't be matched (missing /
 * transient error) is skipped rather than raising false drift. Read-only:
 * GET /feeds. Verify against a live MISP 2.4 instance.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live
  try {
    live = feedsFromList(await getJson<unknown>(`${base}/feeds`, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read feeds, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    const url = String(item.fields.url ?? '').trim()
    const match = findFeed(live, url, name)
    if (!match) continue

    const label = name || url

    const expectedEnabled = normalizeEnabled(item.fields.enabled)
    const actualEnabled = normalizeEnabled(match.enabled)
    if (actualEnabled !== expectedEnabled) {
      diffs.push({ field: `${label}.enabled`, expected: expectedEnabled, actual: actualEnabled, severity: 'warning' })
    }

    const liveUrl = String(match.url ?? '').trim()
    if (url && liveUrl && liveUrl.replace(/\/+$/, '') !== url.replace(/\/+$/, '')) {
      diffs.push({ field: `${label}.url`, expected: url, actual: liveUrl, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
