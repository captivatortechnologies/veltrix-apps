import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, sendJson } from '../../lib/graylogApi'
import { bodyFromLiveIndexSet, type GraylogIndexSet } from './_shared'

/**
 * Undo an index-sets deploy from rollbackData.previous (written by deploy()): for
 * each entry, PUT /api/system/indices/index_sets/{id} with the prior summary
 * (restore), or — when the index set was newly created (prior null) — DELETE it
 * (with delete_indices=true so the backing indices are removed too).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ title: string; indexSetId: string | null; indexSet: GraylogIndexSet | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for index-set rollback' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { indexSetId, indexSet } of previous) {
      if (!indexSetId) {
        skipped++
        continue
      }
      const base_path = `${base}/api/system/indices/index_sets/${encodeURIComponent(indexSetId)}`
      if (indexSet) {
        await sendJson('PUT', base_path, headers, bodyFromLiveIndexSet(indexSet))
        restored++
      } else {
        await sendJson('DELETE', `${base_path}?delete_indices=true`, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back index sets: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
