import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSoarUrl, buildAuthHeader, listAll, getJson } from '../../lib/soarApi'
import { buildListSpec, findListByName, parseFormattedContent, type SoarCustomList } from './_shared'

/**
 * Drift for custom lists: compare declared content, row order included, against
 * the live list's `formatted_content?_output_format=json`. Best-effort — a
 * list that can't be matched or read reports no drift rather than a false
 * positive. Read-only.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildSoarUrl(component, connectivity)
  const headers = buildAuthHeader(credential)

  let live: SoarCustomList[]
  try {
    live = await listAll<SoarCustomList>(base, headers, 'decided_list')
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const spec = buildListSpec(item.fields)
    if (!spec.id || spec.error || !spec.content) continue

    const match = findListByName(live, spec.id)
    if (!match || match.id == null) {
      diffs.push({ field: spec.id, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    try {
      const actual = parseFormattedContent(
        await getJson<unknown>(`${base}/rest/decided_list/${encodeURIComponent(String(match.id))}/formatted_content?_output_format=json`, headers),
      )
      if (JSON.stringify(spec.content) !== JSON.stringify(actual)) {
        diffs.push({ field: spec.id, expected: spec.content, actual, severity: 'warning' })
      }
    } catch {
      continue // best-effort: content unreadable, don't assert drift
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
