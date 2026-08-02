import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildDarktraceUrl, darktraceAuthFrom, dtGetJson } from '../../lib/darktraceApi'
import { entriesFromList, findEntry, normalizeEntry } from './_shared'

/**
 * Drift for the intel feed: every entry we declare should be present on the live
 * watched list. Read-only: GET /intelfeed?fulldetails=true. A declared entry that
 * is missing upstream (removed out-of-band) is drift. Best-effort — if the feed
 * can't be read we assert no drift rather than raising false positives.
 *
 * NOTE: Darktrace's intel feed exposes no per-entry edit, so this checks presence
 * only (not description/expiry/source metadata). Verify against a live Darktrace.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const auth = darktraceAuthFrom(credential)
  if (!auth) return { hasDrift: false, diffs }

  const base = buildDarktraceUrl(component, connectivity, connectivityProvider)

  let live
  try {
    live = entriesFromList(await dtGetJson<unknown>(base, '/intelfeed', { fulldetails: true }, auth))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read the feed, no drift asserted
  }

  for (const item of items) {
    const entry = normalizeEntry(item.fields.entry)
    if (!entry) continue
    if (!findEntry(live, entry)) {
      diffs.push({ field: `${entry}.present`, expected: true, actual: false, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
