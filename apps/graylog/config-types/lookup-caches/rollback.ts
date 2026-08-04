import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, sendJson } from '../../lib/graylogApi'
import { bodyFromLiveLookupCache, type GraylogLookupCache } from './_shared'

/**
 * Undo a lookup-caches deploy from rollbackData.previous (written by deploy()):
 * for each entry, PUT /api/system/lookup/caches/{name} with the prior config
 * (restore), or — when the cache was newly created (prior null) — DELETE
 * /api/system/lookup/caches/{id} to remove it. Graylog refuses to delete a
 * cache still referenced by a lookup table, which surfaces as a clear rollback
 * error rather than being silently skipped.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; cacheId: string | null; cache: GraylogLookupCache | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for lookup-cache rollback' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { name, cacheId, cache } of previous) {
      if (cache) {
        await sendJson('PUT', `${base}/api/system/lookup/caches/${encodeURIComponent(name)}`, headers, bodyFromLiveLookupCache(cache))
        restored++
      } else if (cacheId) {
        await sendJson('DELETE', `${base}/api/system/lookup/caches/${encodeURIComponent(cacheId)}`, headers)
        deleted++
      } else {
        skipped++
      }
    }
    return {
      success: true,
      message: `Rolled back lookup caches: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
