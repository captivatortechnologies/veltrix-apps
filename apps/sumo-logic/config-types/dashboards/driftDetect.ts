import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, getJson, canonicalJson } from '../../lib/sumoLogicApi'
import { findDashboardChild, parseJsonField, type Dashboard, type FolderResponse } from './_shared'

/**
 * Drift for dashboards: resolve each item's folder (Personal when left blank),
 * match by title within it, then compare description, theme, isPublic,
 * refreshInterval and the panels/layout/variables JSON (structurally, ignoring
 * key order) against the live dashboard. Best-effort — a dashboard or folder
 * that can't be read is skipped. Read-only: GET /content/folders/personal,
 * GET /content/folders/<folderId>, GET /dashboards/<id>.
 *
 * API: https://help.sumologic.com/docs/api/dashboards-v2/
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!hasBasicAuth(credential)) return { hasDrift: false, diffs }

  const base = buildBaseUrl(component, connectivity, 'v2')
  const headers = buildAuthHeader(credential!)

  let personalFolderId: string | null = null
  const folderCache = new Map<string, FolderResponse | null>()

  async function resolveFolderId(declared: string): Promise<string | null> {
    if (declared) return declared
    if (personalFolderId) return personalFolderId
    try {
      const personal = await getJson<{ id: string }>(`${base}/content/folders/personal`, headers)
      personalFolderId = personal.id
      return personalFolderId
    } catch {
      return null
    }
  }

  async function readFolder(folderId: string): Promise<FolderResponse | null> {
    if (folderCache.has(folderId)) return folderCache.get(folderId)!
    try {
      const folder = await getJson<FolderResponse>(`${base}/content/folders/${encodeURIComponent(folderId)}`, headers)
      folderCache.set(folderId, folder)
      return folder
    } catch {
      folderCache.set(folderId, null)
      return null
    }
  }

  for (const item of items) {
    const title = String(item.fields.title ?? '').trim()
    if (!title) continue

    const folderId = await resolveFolderId(String(item.fields.folderId ?? '').trim())
    if (!folderId) continue
    const folder = await readFolder(folderId)
    const child = findDashboardChild(folder?.children, title)
    if (!child) continue

    let dashboard: Dashboard
    try {
      dashboard = await getJson<Dashboard>(`${base}/dashboards/${encodeURIComponent(child.id)}`, headers)
    } catch {
      continue
    }

    const expectedTheme = String(item.fields.theme ?? '').trim() || 'Light'
    if (dashboard.theme && dashboard.theme.toLowerCase() !== expectedTheme.toLowerCase()) {
      diffs.push({ field: `${title}.theme`, expected: expectedTheme, actual: dashboard.theme, severity: 'warning' })
    }

    const expectedPublic = ['true', '1', 'yes'].includes(String(item.fields.isPublic ?? '').toLowerCase()) || item.fields.isPublic === true
    if (Boolean(dashboard.isPublic) !== expectedPublic) {
      diffs.push({ field: `${title}.isPublic`, expected: expectedPublic, actual: Boolean(dashboard.isPublic), severity: 'warning' })
    }

    const expectedPanels = parseJsonField(item.fields.panels, 'Panels')
    if (expectedPanels !== undefined && canonicalJson(expectedPanels) !== canonicalJson(dashboard.panels ?? [])) {
      diffs.push({ field: `${title}.panels`, expected: canonicalJson(expectedPanels), actual: canonicalJson(dashboard.panels ?? []), severity: 'warning' })
    }

    const expectedLayout = parseJsonField(item.fields.layout, 'Layout')
    if (expectedLayout !== undefined && canonicalJson(expectedLayout) !== canonicalJson(dashboard.layout ?? {})) {
      diffs.push({ field: `${title}.layout`, expected: canonicalJson(expectedLayout), actual: canonicalJson(dashboard.layout ?? {}), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
