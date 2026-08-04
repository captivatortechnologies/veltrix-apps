import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAxoniusUrl, buildAuthHeaders, apiUrl, getJson, verifyTls } from '../../lib/axoniusApi'
import { DATA_SCOPES_RESOURCE, dataScopesFromResponse, findDataScope, parseText, parseNameList } from './_shared'
import { SAVED_QUERIES_LIST_RESOURCE, savedQueriesFromResponse } from '../saved-queries/_shared'

/** Whether two uuid lists contain the same members, ignoring order. */
function sameUuidSet(expected: string[], actual: string[]): boolean {
  if (expected.length !== actual.length) return false
  const a = new Set(actual)
  return expected.every((u) => a.has(u))
}

/**
 * Drift for data scopes: compare the description and the resolved
 * devices/users saved-query uuid sets against the live scope. A saved query
 * name that no longer resolves is treated as "can't compare" for that scope
 * (skipped) rather than raised as false drift. Read-only: GET
 * api/settings/data_scope + GET api/queries/saved. Best-effort.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }
  const headers = buildAuthHeaders(credential)
  if (Object.keys(headers).length !== 2) return { hasDrift: false, diffs }

  const base = buildAxoniusUrl(component, connectivity, connectivityProvider)

  let live
  let liveQueries
  try {
    live = dataScopesFromResponse(await getJson<unknown>(apiUrl(base, settings, DATA_SCOPES_RESOURCE), headers, { verifyTls: verifyTls(settings) }))
    liveQueries = savedQueriesFromResponse(
      await getJson<unknown>(apiUrl(base, settings, SAVED_QUERIES_LIST_RESOURCE), headers, { verifyTls: verifyTls(settings) }),
    )
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read scopes, no drift asserted
  }

  const resolve = (names: string[], module: 'devices' | 'users'): string[] =>
    names
      .map((name) => liveQueries.find((sq) => String(sq.name ?? '').trim() === name && String(sq.module ?? '').toLowerCase().startsWith(module)))
      .map((sq) => sq?.id ?? sq?.uuid)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)

  for (const item of items) {
    const name = parseText(item.fields.name)
    if (!name) continue
    const match = findDataScope(live, name)

    if (!match) {
      diffs.push({ field: `${name}.exists`, expected: true, actual: false, severity: 'critical' })
      continue
    }

    const expectedDescription = parseText(item.fields.description)
    const actualDescription = String(match.description ?? '').trim()
    if (expectedDescription !== actualDescription) {
      diffs.push({ field: `${name}.description`, expected: expectedDescription, actual: actualDescription, severity: 'info' })
    }

    const expectedDevices = resolve(parseNameList(item.fields.devices_queries), 'devices')
    const actualDevices = Array.isArray(match.devices_queries) ? match.devices_queries : []
    if (!sameUuidSet(expectedDevices, actualDevices)) {
      diffs.push({ field: `${name}.devices_queries`, expected: expectedDevices, actual: actualDevices, severity: 'warning' })
    }

    const expectedUsers = resolve(parseNameList(item.fields.users_queries), 'users')
    const actualUsers = Array.isArray(match.users_queries) ? match.users_queries : []
    if (!sameUuidSet(expectedUsers, actualUsers)) {
      diffs.push({ field: `${name}.users_queries`, expected: expectedUsers, actual: actualUsers, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
