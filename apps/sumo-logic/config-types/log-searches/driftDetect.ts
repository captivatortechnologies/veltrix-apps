import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, getJson, canonicalJson } from '../../lib/sumoLogicApi'
import { findLogSearchChild, parseJsonField, type FolderResponse, type LogSearch } from './_shared'

/**
 * Drift for log searches: resolve each item's folder (Personal when left
 * blank), match by name within it, then compare queryString, parsingMode and
 * the schedule JSON (structurally, ignoring key order) against the live
 * search. Best-effort — a search or folder that can't be read is skipped.
 * Read-only: GET /v2/content/folders/personal, GET /v2/content/folders/<id>,
 * GET /v1/logSearches/<id>.
 *
 * API: https://help.sumologic.com/docs/api/log-searches/
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!hasBasicAuth(credential)) return { hasDrift: false, diffs }

  const base = buildBaseUrl(component, connectivity)
  const contentBase = buildBaseUrl(component, connectivity, 'v2')
  const headers = buildAuthHeader(credential!)

  let personalFolderId: string | null = null
  const folderCache = new Map<string, FolderResponse | null>()

  async function resolveParentId(declared: string): Promise<string | null> {
    if (declared) return declared
    if (personalFolderId) return personalFolderId
    try {
      const personal = await getJson<{ id: string }>(`${contentBase}/content/folders/personal`, headers)
      personalFolderId = personal.id
      return personalFolderId
    } catch {
      return null
    }
  }

  async function readFolder(parentId: string): Promise<FolderResponse | null> {
    if (folderCache.has(parentId)) return folderCache.get(parentId)!
    try {
      const folder = await getJson<FolderResponse>(`${contentBase}/content/folders/${encodeURIComponent(parentId)}`, headers)
      folderCache.set(parentId, folder)
      return folder
    } catch {
      folderCache.set(parentId, null)
      return null
    }
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue

    const parentId = await resolveParentId(String(item.fields.parentId ?? '').trim())
    if (!parentId) continue
    const folder = await readFolder(parentId)
    const child = findLogSearchChild(folder?.children, name)
    if (!child) continue

    let search: LogSearch
    try {
      search = await getJson<LogSearch>(`${base}/logSearches/${encodeURIComponent(child.id)}`, headers)
    } catch {
      continue
    }

    const expectedQuery = String(item.fields.queryString ?? '').trim()
    const actualQuery = String(search.queryString ?? '').trim()
    if (expectedQuery && actualQuery !== expectedQuery) {
      diffs.push({ field: `${name}.queryString`, expected: expectedQuery, actual: actualQuery, severity: 'warning' })
    }

    const expectedParsingMode = String(item.fields.parsingMode ?? '').trim() || 'Manual'
    if (search.parsingMode && search.parsingMode !== expectedParsingMode) {
      diffs.push({ field: `${name}.parsingMode`, expected: expectedParsingMode, actual: search.parsingMode, severity: 'warning' })
    }

    const expectedSchedule = parseJsonField(item.fields.schedule, 'Schedule')
    const actualSchedule = search.schedule
    if ((expectedSchedule || actualSchedule) && canonicalJson(expectedSchedule ?? null) !== canonicalJson(actualSchedule ?? null)) {
      diffs.push({
        field: `${name}.schedule`,
        expected: canonicalJson(expectedSchedule ?? null),
        actual: canonicalJson(actualSchedule ?? null),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
