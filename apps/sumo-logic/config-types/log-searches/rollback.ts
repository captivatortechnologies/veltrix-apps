import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, sendJson } from '../../lib/sumoLogicApi'
import type { LogSearch } from './_shared'

/**
 * Undo a log-searches deploy from rollbackData.previous (written by deploy()):
 * for each entry, PUT /logSearches/<id> with the prior full body (restore), or
 * — when the search was newly created (prior body null) — DELETE
 * /logSearches/<id> to remove it. Applied over the Sumo Logic Management API.
 *
 * API: https://help.sumologic.com/docs/api/log-searches/
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; searchId: string | null; search: LogSearch | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for log search rollback' }
  }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { searchId, search } of previous) {
      if (searchId == null) {
        // A created search whose id we never learned — nothing safe to undo.
        skipped++
        continue
      }
      const path = `${base}/logSearches/${encodeURIComponent(searchId)}`
      if (search) {
        const { id: _id, parentId: _p, ...body } = search
        await sendJson('PUT', path, headers, body)
        restored++
      } else {
        await sendJson('DELETE', path, headers)
        deleted++
      }
    }
    return {
      success: true,
      message: `Rolled back log searches: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
