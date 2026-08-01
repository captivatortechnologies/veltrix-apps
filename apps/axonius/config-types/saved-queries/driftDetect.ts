import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAxoniusUrl, buildAuthHeaders, apiUrl, getJson, verifyTls } from '../../lib/axoniusApi'
import {
  SAVED_QUERIES_LIST_RESOURCE,
  savedQueriesFromResponse,
  findSavedQuery,
  normalizeEntity,
  parseFilter,
  parseFields,
} from './_shared'

/**
 * Drift for saved queries: compare the AQL filter and the column set we declare
 * against the live saved query in Axonius. Best-effort — a query that can't be
 * matched (missing / transient error) is skipped rather than raising false drift.
 * Read-only: GET api/queries/saved. Verify against a live Axonius tenant.
 */
function sameColumns(expected: string[], actual: string[]): boolean {
  if (expected.length === 0) return true // empty = "use Axonius defaults"; not asserted
  if (expected.length !== actual.length) return false
  return expected.every((f, i) => f === actual[i])
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }
  const headers = buildAuthHeaders(credential)
  if (Object.keys(headers).length !== 2) return { hasDrift: false, diffs }

  const base = buildAxoniusUrl(component, connectivity, connectivityProvider)

  let live
  try {
    live = savedQueriesFromResponse(
      await getJson<unknown>(apiUrl(base, settings, SAVED_QUERIES_LIST_RESOURCE), headers, { verifyTls: verifyTls(settings) }),
    )
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read queries, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const entity = normalizeEntity(item.fields.entity)
    const match = findSavedQuery(live, name, entity)
    if (!match) continue

    const label = `${entity}/${name}`

    const expectedFilter = parseFilter(item.fields.query)
    const actualFilter = String(match.view?.query?.filter ?? '').trim()
    if (expectedFilter !== actualFilter) {
      diffs.push({ field: `${label}.query`, expected: expectedFilter, actual: actualFilter, severity: 'warning' })
    }

    const expectedFields = parseFields(item.fields.fields)
    const actualFields = Array.isArray(match.view?.fields) ? match.view!.fields!.map((f) => String(f)) : []
    if (!sameColumns(expectedFields, actualFields)) {
      diffs.push({ field: `${label}.fields`, expected: expectedFields, actual: actualFields, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
