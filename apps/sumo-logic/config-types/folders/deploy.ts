import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, getJson, sendJson } from '../../lib/sumoLogicApi'
import { buildFolderCreateBody, buildFolderUpdateBody, findFolderChild, type FolderResponse } from './_shared'

/**
 * Deploy Sumo Logic Content folders over the Management API v2 (HTTPS). There
 * is no plain "list all" endpoint — folders are discovered per PARENT:
 *   read parent:  GET  /content/folders/<parentId>       → { children: [...] } (cached per parent within this deploy)
 *   create:       POST /content/folders                  with { name, description, parentId }
 *   update:       PUT  /content/folders/<id>              with { name, description } (parentId is not re-sent)
 *
 * The folder NAME is the stable identity used to upsert, scoped to its parent
 * (Sumo Logic only enforces name-uniqueness per parent). rollbackData records,
 * per folder, the prior body (null when it did not exist) AND the folder id —
 * so rollback can restore the prior body or delete the one we created
 * (folder deletion is asynchronous — see rollback.ts).
 *
 * API: https://help.sumologic.com/docs/api/content-management/
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for folder deployment' }
  }

  const base = buildBaseUrl(component, connectivity, 'v2')
  const headers = buildAuthHeader(credential!)

  const previous: Array<{ name: string; folderId: string | null; folder: FolderResponse | null }> = []
  const applied: string[] = []

  const parentCache = new Map<string, FolderResponse | null>()
  async function readParent(parentId: string): Promise<FolderResponse | null> {
    if (parentCache.has(parentId)) return parentCache.get(parentId)!
    try {
      const parent = await getJson<FolderResponse>(`${base}/content/folders/${encodeURIComponent(parentId)}`, headers)
      parentCache.set(parentId, parent)
      return parent
    } catch {
      parentCache.set(parentId, null)
      return null
    }
  }

  try {
    for (const item of items) {
      const name = String(item.fields.name ?? '').trim()
      const parentId = String(item.fields.parentId ?? '').trim()
      if (!name || !parentId) continue

      const parent = await readParent(parentId)
      const match = findFolderChild(parent?.children, name)

      if (match) {
        const fullExisting = await getJson<FolderResponse>(`${base}/content/folders/${encodeURIComponent(match.id)}`, headers)
        await sendJson('PUT', `${base}/content/folders/${encodeURIComponent(match.id)}`, headers, buildFolderUpdateBody(item.fields))
        previous.push({ name, folderId: match.id, folder: fullExisting })
      } else {
        const created = await sendJson<{ id: string }>('POST', `${base}/content/folders`, headers, buildFolderCreateBody(item.fields))
        previous.push({ name, folderId: created?.id ?? null, folder: null })
      }
      applied.push(name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} folder(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Folder deploy failed after ${applied.length} folder(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
