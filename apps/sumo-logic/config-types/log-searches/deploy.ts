import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, getJson, sendJson } from '../../lib/sumoLogicApi'
import { buildLogSearchCreateBody, buildLogSearchUpdateBody, findLogSearchChild, type FolderResponse, type LogSearch } from './_shared'

/**
 * Deploy Sumo Logic log searches over the Management API (HTTPS). Discovery is
 * per FOLDER (the v2 Content Library tree, the same one Folders and Dashboards
 * in this app use) since there is no reliable name-based lookup:
 *   resolve folder: GET  /v2/content/folders/personal          → personal folder id (when parentId is blank)
 *   read folder:    GET  /v2/content/folders/<parentId>        → { children: [...] } (cached per folder within this deploy)
 *   read search:    GET  /v1/logSearches/<id>                   → full body
 *   create:         POST /v1/logSearches                        with { parentId, ...LogSearchDefinition } (SaveLogSearchRequest)
 *   update:         PUT  /v1/logSearches/<id>                    with LogSearchDefinition (no parentId — not re-parented here)
 *
 * The search NAME is the stable identity used to upsert, scoped to its folder.
 * rollbackData records, per search, the prior full body (null when it did not
 * exist) AND the search id — so rollback can restore the prior body or delete
 * the one we created.
 *
 * API: https://help.sumologic.com/docs/api/log-searches/
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for log search deployment' }
  }

  const base = buildBaseUrl(component, connectivity)
  const contentBase = buildBaseUrl(component, connectivity, 'v2')
  const headers = buildAuthHeader(credential!)

  const previous: Array<{ name: string; searchId: string | null; search: LogSearch | null }> = []
  const applied: string[] = []

  let personalFolderId: string | null = null
  const folderCache = new Map<string, FolderResponse | null>()

  async function resolveParentId(declared: string): Promise<string> {
    if (declared) return declared
    if (personalFolderId) return personalFolderId
    const personal = await getJson<{ id: string }>(`${contentBase}/content/folders/personal`, headers)
    personalFolderId = personal.id
    return personalFolderId
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

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      if (!name) continue

      const parentId = await resolveParentId(String(item.fields.parentId ?? '').trim())
      const folder = await readFolder(parentId)
      const match = findLogSearchChild(folder?.children, name)

      if (match) {
        const fullExisting = await getJson<LogSearch>(`${base}/logSearches/${encodeURIComponent(match.id)}`, headers)
        await sendJson('PUT', `${base}/logSearches/${encodeURIComponent(match.id)}`, headers, buildLogSearchUpdateBody(item.fields))
        previous.push({ name, searchId: match.id, search: fullExisting })
      } else {
        const body = buildLogSearchCreateBody(item.fields, parentId)
        const created = await sendJson<{ id: string }>('POST', `${base}/logSearches`, headers, body)
        previous.push({ name, searchId: created?.id ?? null, search: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} log search(es): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Log search deploy failed after ${applied.length} search(es): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
