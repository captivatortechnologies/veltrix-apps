import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson } from '../../lib/graylogApi'
import { asString } from '../../lib/coerce'
import { lookupTablesFromList, findLookupTable, resolveCacheId, resolveDataAdapterId } from './_shared'

/**
 * Drift for lookup tables: compare the resolved cache/data-adapter id and the
 * default-value fields we declare against the live table in Graylog.
 * Best-effort — a table, cache or adapter that can't be matched is skipped
 * rather than raising false drift. Read-only: GET /api/system/lookup/tables.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live
  try {
    live = lookupTablesFromList(await getJson<unknown>(`${base}/api/system/lookup/tables`, headers))
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const name = asString(item.fields.name)
    const match = findLookupTable(live, name)
    if (!match) continue

    const cacheId = await resolveCacheId(base, headers, asString(item.fields.cache_name))
    if (cacheId && cacheId !== asString(match.cache_id)) {
      diffs.push({ field: `${name}.cache_id`, expected: cacheId, actual: asString(match.cache_id), severity: 'warning' })
    }

    const dataAdapterId = await resolveDataAdapterId(base, headers, asString(item.fields.data_adapter_name))
    if (dataAdapterId && dataAdapterId !== asString(match.data_adapter_id)) {
      diffs.push({ field: `${name}.data_adapter_id`, expected: dataAdapterId, actual: asString(match.data_adapter_id), severity: 'warning' })
    }

    const expectedSingle = asString(item.fields.default_single_value)
    const actualSingle = asString(match.default_single_value)
    if (expectedSingle !== actualSingle) {
      diffs.push({ field: `${name}.default_single_value`, expected: expectedSingle, actual: actualSingle, severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
