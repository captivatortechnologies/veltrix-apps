import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, sendJson } from '../../lib/graylogApi'
import { bodyFromLiveLookupDataAdapter, type GraylogLookupDataAdapter } from './_shared'

/**
 * Undo a lookup-data-adapters deploy from rollbackData.previous (written by
 * deploy()): for each entry, PUT /api/system/lookup/adapters/{name} with the
 * prior config (restore), or — when the adapter was newly created (prior null)
 * — DELETE /api/system/lookup/adapters/{id} to remove it. Graylog refuses to
 * delete an adapter still referenced by a lookup table, which surfaces as a
 * clear rollback error rather than being silently skipped.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const data = (ctx.rollbackData ?? {}) as {
    previous?: Array<{ name: string; adapterId: string | null; adapter: GraylogLookupDataAdapter | null }>
  }
  const previous = data.previous ?? []
  if (previous.length === 0) return { success: true, message: 'Nothing to roll back.' }

  if (!credential) {
    return { success: false, message: 'Missing credential for lookup-data-adapter rollback' }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let restored = 0
  let deleted = 0
  let skipped = 0
  try {
    for (const { name, adapterId, adapter } of previous) {
      if (adapter) {
        await sendJson('PUT', `${base}/api/system/lookup/adapters/${encodeURIComponent(name)}`, headers, bodyFromLiveLookupDataAdapter(adapter))
        restored++
      } else if (adapterId) {
        await sendJson('DELETE', `${base}/api/system/lookup/adapters/${encodeURIComponent(adapterId)}`, headers)
        deleted++
      } else {
        skipped++
      }
    }
    return {
      success: true,
      message: `Rolled back lookup data adapters: ${restored} restored, ${deleted} deleted${skipped ? `, ${skipped} skipped` : ''}.`,
    }
  } catch (error) {
    return { success: false, message: `Rollback failed: ${error instanceof Error ? error.message : 'Unknown error'}` }
  }
}
