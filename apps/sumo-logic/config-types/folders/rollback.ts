import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, sendJson, pollAsyncJob } from '../../lib/sumoLogicApi'
import { buildFolderUpdateBody, type FolderResponse } from './_shared'

/**
 * Undo a folders deploy from rollbackData.previous (written by deploy()): for
 * each entry, PUT /content/folders/<id> with the prior body (restore), or —
 * when the folder was newly created (prior body null) — start an asynchronous
 * delete job (DELETE /content/<id>/delete → { id: jobId }) and poll it to
 * completion. Folder deletion is the one asynchronous operation in this app;
 * every other config type's writes are synchronous.
 *
 * API: https://help.sumologic.com/docs/api/content-management/
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; folderId: string | null; folder: FolderResponse | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for folder rollback' }
  }

  const base = buildBaseUrl(component, connectivity, 'v2')
  const headers = buildAuthHeader(credential!)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { folderId, folder } of previous) {
      if (folderId == null) {
        // A created folder whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      if (folder) {
        await sendJson('PUT', `${base}/content/folders/${encodeURIComponent(folderId)}`, headers, buildFolderUpdateBody(folder))
        restored++
      } else {
        const job = await sendJson<{ id: string }>('DELETE', `${base}/content/${encodeURIComponent(folderId)}/delete`, headers)
        const status = await pollAsyncJob(`${base}/content/${encodeURIComponent(folderId)}/delete/${encodeURIComponent(job.id)}/status`, headers)
        if (status.status !== 'Success') {
          throw new Error(`Folder delete job did not succeed: ${status.statusMessage || status.status}`)
        }
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back folders: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
