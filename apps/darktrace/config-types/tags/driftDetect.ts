import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildDarktraceUrl, darktraceAuthFrom, dtGetJson } from '../../lib/darktraceApi'
import { findTag, normalizeName, tagsFromList } from './_shared'

/**
 * Drift for tags: every tag we declare should be present on the live tag list.
 * Read-only: GET /tags. A declared tag that is missing upstream (deleted
 * out-of-band) is drift. Best-effort — if the list can't be read we assert no
 * drift rather than raising false positives.
 *
 * NOTE: Darktrace's tags expose no per-tag edit, so this checks presence only
 * (not colour / description). Verify against a live Darktrace.
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
    live = tagsFromList(await dtGetJson<unknown>(base, '/tags', {}, auth))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read tags, no drift asserted
  }

  for (const item of items) {
    const name = normalizeName(item.fields.name)
    if (!name) continue
    if (!findTag(live, name)) {
      diffs.push({ field: `${name}.present`, expected: true, actual: false, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
