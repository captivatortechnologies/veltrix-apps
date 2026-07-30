import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, getJson } from '../../lib/mispApi'
import { serversFromList, findServer, normalizeYesNo, normalizeUrl } from './_shared'

/**
 * Drift for sync servers: compare the remote URL and pull/push directions we
 * declare against the live server in MISP. The authkey is sensitive and never read
 * back, so it is not compared. Best-effort — a server that can't be matched
 * (missing / transient error) is skipped rather than raising false drift.
 * Read-only: GET /servers. Verify against a live MISP 2.4 instance.
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
    live = serversFromList(await getJson<unknown>(`${base}/servers`, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read servers, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    const url = String(item.fields.url ?? '').trim()
    const match = findServer(live, url, name)
    if (!match) continue

    const label = name || url

    const liveUrl = normalizeUrl(match.url)
    if (url && liveUrl && liveUrl !== normalizeUrl(url)) {
      diffs.push({ field: `${label}.url`, expected: url, actual: String(match.url ?? '').trim(), severity: 'warning' })
    }

    const expectedPull = normalizeYesNo(item.fields.pull)
    const actualPull = normalizeYesNo(match.pull)
    if (actualPull !== expectedPull) {
      diffs.push({ field: `${label}.pull`, expected: expectedPull, actual: actualPull, severity: 'warning' })
    }

    const expectedPush = normalizeYesNo(item.fields.push)
    const actualPush = normalizeYesNo(match.push)
    if (actualPush !== expectedPush) {
      diffs.push({ field: `${label}.push`, expected: expectedPush, actual: actualPush, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
