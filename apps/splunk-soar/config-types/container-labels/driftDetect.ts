import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSoarUrl, buildAuthHeader, getJson } from '../../lib/soarApi'
import { buildLabelName, parseLabelList } from './_shared'

/**
 * Drift for container labels: a declared label missing from SOAR's live
 * label list is critical drift. This type never owns the full label
 * namespace, so an extra live-only label is not reported as drift.
 * Read-only: GET /rest/system_settings/labels.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildSoarUrl(component, connectivity)
  const headers = buildAuthHeader(credential)

  let live: Set<string>
  try {
    live = new Set(parseLabelList(await getJson<unknown>(`${base}/rest/system_settings/labels`, headers)).map((l) => l.toLowerCase()))
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = buildLabelName(item.fields)
    if (!name) continue
    if (!live.has(name.toLowerCase())) {
      diffs.push({ field: name, expected: 'present', actual: 'missing', severity: 'critical' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
