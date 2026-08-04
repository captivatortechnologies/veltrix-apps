import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, getJson, sendJson } from '../../lib/sumoLogicApi'
import { buildDashboardBody, findDashboardChild, type Dashboard, type FolderResponse } from './_shared'

/**
 * Deploy Sumo Logic dashboards over the Management API v2 (HTTPS). There is no
 * name-based lookup — dashboards are discovered per FOLDER, the same shape the
 * Monitors and Folders config types in this app use:
 *   resolve folder: GET  /content/folders/personal            → personal folder id (when folderId is blank)
 *   read folder:    GET  /content/folders/<folderId>          → { children: [...] } (cached per folder within this deploy)
 *   read dashboard: GET  /dashboards/<id>                      → full body
 *   create:         POST /dashboards                           with the full DashboardRequest
 *   update:         PUT  /dashboards/<id>                       with the full DashboardRequest (id lives in the path)
 *
 * The dashboard TITLE is the stable identity used to upsert, scoped to its
 * folder. rollbackData records, per dashboard, the prior full body (null when
 * it did not exist) AND the dashboard id — so rollback can restore the prior
 * body or delete the one we created.
 *
 * API: https://help.sumologic.com/docs/api/dashboards-v2/
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for dashboard deployment' }
  }

  const base = buildBaseUrl(component, connectivity, 'v2')
  const headers = buildAuthHeader(credential!)

  const previous: Array<{ title: string; dashboardId: string | null; dashboard: Dashboard | null }> = []
  const applied: string[] = []

  let personalFolderId: string | null = null
  const folderCache = new Map<string, FolderResponse | null>()

  async function resolveFolderId(declared: string): Promise<string> {
    if (declared) return declared
    if (personalFolderId) return personalFolderId
    const personal = await getJson<{ id: string }>(`${base}/content/folders/personal`, headers)
    personalFolderId = personal.id
    return personalFolderId
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

  try {
    for (const item of items) {
      const title = String(item.fields.title ?? '').trim()
      if (!title) continue

      const folderId = await resolveFolderId(String(item.fields.folderId ?? '').trim())
      const folder = await readFolder(folderId)
      const match = findDashboardChild(folder?.children, title)

      if (match) {
        const fullExisting = await getJson<Dashboard>(`${base}/dashboards/${encodeURIComponent(match.id)}`, headers)
        const body = { ...buildDashboardBody(item.fields), folderId }
        await sendJson('PUT', `${base}/dashboards/${encodeURIComponent(match.id)}`, headers, body)
        previous.push({ title, dashboardId: match.id, dashboard: fullExisting })
      } else {
        const body = { ...buildDashboardBody(item.fields), folderId }
        const created = await sendJson<{ id: string }>('POST', `${base}/dashboards`, headers, body)
        previous.push({ title, dashboardId: created?.id ?? null, dashboard: null })
      }
      applied.push(title)
    }

    return {
      success: true,
      message: `Applied ${applied.length} dashboard(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Dashboard deploy failed after ${applied.length} dashboard(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
