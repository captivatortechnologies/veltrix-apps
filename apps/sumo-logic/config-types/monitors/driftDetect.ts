import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, getJson } from '../../lib/sumoLogicApi'
import { canonicalJson, findMonitorChild, tryParseJsonArray, type Monitor, type MonitorsLibraryFolderResponse } from './_shared'

/**
 * Drift for monitors: resolve each item's parent folder, match by name within
 * it, then compare description, monitorType, isDisabled, queries and triggers
 * against the live monitor (queries/triggers compared structurally, ignoring
 * key order). Best-effort — a monitor or folder that can't be read is skipped
 * rather than raising false drift. Read-only: GET /monitors/root,
 * GET /monitors/<parentId>, GET /monitors/<id>.
 *
 * API: https://help.sumologic.com/docs/api/monitors/
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!hasBasicAuth(credential)) return { hasDrift: false, diffs }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  let rootId: string | null = null
  const folderCache = new Map<string, MonitorsLibraryFolderResponse | null>()

  async function resolveParentId(declared: string): Promise<string | null> {
    if (declared) return declared
    if (rootId) return rootId
    try {
      const root = await getJson<{ id: string }>(`${base}/monitors/root`, headers)
      rootId = root.id
      return rootId
    } catch {
      return null
    }
  }

  async function readFolder(parentId: string): Promise<MonitorsLibraryFolderResponse | null> {
    if (folderCache.has(parentId)) return folderCache.get(parentId)!
    try {
      const folder = await getJson<MonitorsLibraryFolderResponse>(`${base}/monitors/${encodeURIComponent(parentId)}`, headers)
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
    const child = findMonitorChild(folder?.children, name)
    if (!child) continue

    let monitor: Monitor
    try {
      monitor = await getJson<Monitor>(`${base}/monitors/${encodeURIComponent(child.id)}`, headers)
    } catch {
      continue
    }

    const expectedType = String(item.fields.monitorType ?? '').trim() || 'Logs'
    if (monitor.monitorType && monitor.monitorType !== expectedType) {
      diffs.push({ field: `${name}.monitorType`, expected: expectedType, actual: monitor.monitorType, severity: 'warning' })
    }

    const expectedDisabled = ['true', '1', 'yes'].includes(String(item.fields.isDisabled ?? '').toLowerCase()) || item.fields.isDisabled === true
    if (Boolean(monitor.isDisabled) !== expectedDisabled) {
      diffs.push({ field: `${name}.isDisabled`, expected: expectedDisabled, actual: Boolean(monitor.isDisabled), severity: 'warning' })
    }

    const expectedQueries = tryParseJsonArray(item.fields.queries, 'Queries')
    if (expectedQueries && canonicalJson(expectedQueries) !== canonicalJson(monitor.queries ?? [])) {
      diffs.push({ field: `${name}.queries`, expected: canonicalJson(expectedQueries), actual: canonicalJson(monitor.queries ?? []), severity: 'warning' })
    }

    const expectedTriggers = tryParseJsonArray(item.fields.triggers, 'Triggers')
    if (expectedTriggers && canonicalJson(expectedTriggers) !== canonicalJson(monitor.triggers ?? [])) {
      diffs.push({ field: `${name}.triggers`, expected: canonicalJson(expectedTriggers), actual: canonicalJson(monitor.triggers ?? []), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
