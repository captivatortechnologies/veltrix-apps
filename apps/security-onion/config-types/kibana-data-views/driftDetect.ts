import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSocUrl, buildAuthHeader, getJson } from '../../lib/soConsole'
import type { DataViewGetResponse } from './_shared'

/**
 * Drift for data views: compare the title/name/timeFieldName we declare
 * against the live data view on Kibana. Best-effort — a data view that can't
 * be read (missing / transient error) is skipped rather than raising false
 * drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildSocUrl(component, connectivity, connectivityProvider)
  const headers = { ...buildAuthHeader(credential), 'kbn-xsrf': 'true' }

  for (const item of items) {
    const dataViewId = String(item.fields.dataViewId ?? '').trim()
    if (!dataViewId) continue

    let live: Record<string, unknown> | null = null
    try {
      const res = await getJson<DataViewGetResponse>(`${base}/api/data_views/data_view/${encodeURIComponent(dataViewId)}`, headers)
      live = res.data_view ?? null
    } catch {
      continue // best-effort: skip a data view we can't read
    }
    if (!live) continue

    const expectedTitle = String(item.fields.title ?? '').trim()
    if (typeof live.title === 'string' && live.title !== expectedTitle) {
      diffs.push({ field: `${dataViewId}.title`, expected: expectedTitle, actual: live.title, severity: 'warning' })
    }

    const expectedName = String(item.fields.name ?? '').trim()
    if (typeof live.name === 'string' && live.name !== expectedName) {
      diffs.push({ field: `${dataViewId}.name`, expected: expectedName, actual: live.name, severity: 'warning' })
    }

    const expectedTimeField = String(item.fields.timeFieldName ?? '').trim()
    if (expectedTimeField && live.timeFieldName !== undefined && live.timeFieldName !== expectedTimeField) {
      diffs.push({ field: `${dataViewId}.timeFieldName`, expected: expectedTimeField, actual: (live.timeFieldName as string) ?? null, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
