import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient, secretServerErrorMessage, parseJson } from '../../lib/secretServerApi'
import {
  extractFolderSpecs,
  searchFolders,
  resolveParentFolderId,
  findFolderByNameAndParent,
  buildFolderCreateBody,
  buildFolderUpdateBody,
  folderIdOf,
  type LiveFolder,
} from './_shared'

/**
 * One folder's prior state, captured for rollback. `existed` distinguishes an
 * UPDATE (restore `prior`) from a CREATE (leave the new folder in place).
 */
export interface FolderRollbackEntry {
  folderName: string
  parentFolderId: number
  folderId: number | null
  existed: boolean
  prior: LiveFolder | null
}

/**
 * Deploy Secret Server folders over the REST API (/api/v1/folders):
 *   resolve parent: parentFolderName → parentFolderId (blank → root)
 *   read:           GET   /folders?filter.searchText=<name>   → match name + parent
 *   create:         POST  /folders                            with the folder body
 *   update:         PATCH /folders/{id}                       with the managed fields
 *
 * Identity is folderName WITHIN its parent. rollbackData records, per folder, the
 * prior folder body (null when it did not exist) AND its id — so rollback can
 * restore the prior body, or leave a newly created folder in place (folder
 * deletion is destructive over this seam).
 *
 * NOTE: verify /folders search + create + PATCH against a live Secret Server.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSecretServerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, apiBase } = built

  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const specs = extractFolderSpecs(items).filter((s) => s.folderName)

  const previous: FolderRollbackEntry[] = []
  const applied: string[] = []

  try {
    for (const spec of specs) {
      const parent = await resolveParentFolderId(client, spec.parentFolderName)
      if (parent.id === null) throw new Error(parent.error ?? `Could not resolve the parent folder for "${spec.folderName}"`)
      const parentId = parent.id

      const siblings = await searchFolders(client, spec.folderName)
      const existing = findFolderByNameAndParent(siblings, spec.folderName, parentId)

      if (existing) {
        const folderId = folderIdOf(existing)
        if (folderId === null) throw new Error(`Folder "${spec.folderName}" exists but has no usable id`)
        const res = await client.request('PATCH', `/folders/${folderId}`, { body: buildFolderUpdateBody(spec, existing) })
        if (!res.ok) throw new Error(`Failed to update folder "${spec.folderName}": ${secretServerErrorMessage(res)}`)
        previous.push({ folderName: spec.folderName, parentFolderId: parentId, folderId, existed: true, prior: existing })
      } else {
        const res = await client.request('POST', '/folders', { body: buildFolderCreateBody(spec, parentId) })
        if (!res.ok) throw new Error(`Failed to create folder "${spec.folderName}": ${secretServerErrorMessage(res)}`)
        const created = parseJson<LiveFolder>(res.body)
        previous.push({
          folderName: spec.folderName,
          parentFolderId: parentId,
          folderId: created ? folderIdOf(created) : null,
          existed: false,
          prior: null,
        })
      }
      applied.push(spec.folderName)
    }

    return {
      success: true,
      message: `Applied ${applied.length} folder(s) to ${apiBase}: ${applied.join(', ') || '(none)'}`,
      artifacts: { apiBase, applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Folder deploy failed after ${applied.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { apiBase, applied },
      rollbackData: { previous },
    }
  }
}
